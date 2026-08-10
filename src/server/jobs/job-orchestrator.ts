import { randomUUID } from "node:crypto";
import { access, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PersistedJob } from "../domain/job.js";
import { DomainError } from "../domain/errors.js";
import { buildEpub } from "../epub/build.js";
import { validateEpub, validateEpubArchive, type ValidationReport } from "../epub/validate.js";
import { prepareBook, runPreparedBook } from "./book-pipeline.js";
import type { JobRepository } from "../storage/job-repository.js";
import { jobRoot } from "../storage/job-paths.js";
import { readJournal } from "../storage/ndjson-journal.js";
import { Scheduler } from "./scheduler.js";
import { syncParentDirectory } from "../storage/atomic-file.js";
import { redact } from "../domain/redaction.js";
import { readUsageReport, type UsageReport } from "./usage-service.js";

type UpdateJob = (patch: Partial<PersistedJob>) => Promise<void>;
type RunBook = (
  root: string,
  job: PersistedJob,
  update: UpdateJob,
  signal?: AbortSignal,
  recoverCompatibleCheckpoints?: boolean,
) => Promise<unknown>;
type EventCallback = (
  jobId: string,
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => Promise<void> | void;
type ActiveTask = {
  controller: AbortController;
  promise: Promise<void>;
  kind: "analysis" | "translation";
};
type JournalRecord = {
  batchId: string;
  segments?: unknown[];
  warnings?: unknown[];
  attempts?: number;
};

export type JobResults = {
  validation: ValidationReport | null;
  usage: UsageReport;
  statistics: {
    translated: number;
    edited: number;
    translationAttempts: number;
    editingAttempts: number;
    auditAttempts: number;
    repairAttempts: number;
    warnings: number;
    outputAvailable: boolean;
  };
  /** Audit failures are their own signal, not another quality warning. */
  quality: {
    auditedSegments: number;
    flaggedSegments: number;
    auditErrorSegments: number;
    auditErrorsByKind: { malformed_json: number; invalid_issues: number };
    rejectedRepairs: number;
  } | null;
  consistency: {
    entities: number;
    filteredEntities: number;
    chunks: number;
    resolvedChunks: number;
    failedChunks: number;
    decisions: number;
    applied: number;
    mechanicalApplied: number;
    glossaryAligned: number;
    /** Entries the models used in fewer than half the blocks that name them. */
    ignoredGlossaryEntries: number;
  } | null;
};

/** Reasons the pipeline finished the book without one of its correctness passes. */
function degradedReasons(outcome: unknown): string[] {
  const reasons = (outcome as { degraded?: unknown } | null)?.degraded;
  return Array.isArray(reasons) ? reasons.filter((reason) => typeof reason === "string") : [];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reports are advisory: a job that never reached a stage simply has no file for it. */
async function readJsonReport(path: string): Promise<Record<string, any> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export class JobOrchestrator {
  private readonly scheduler = new Scheduler();
  private readonly active = new Map<string, ActiveTask>();
  private readonly claims = new Set<string>();
  private readonly launches = new Map<string, Promise<PersistedJob>>();
  private readonly runBook: RunBook;
  private readonly onEvent?: EventCallback;

  constructor(
    private readonly repo: JobRepository,
    options: { runBook?: RunBook; onEvent?: EventCallback } = {},
  ) {
    this.runBook =
      options.runBook ??
      ((root, job, update, signal, recoverCompatibleCheckpoints) =>
        runPreparedBook(root, job, update, signal, recoverCompatibleCheckpoints));
    this.onEvent = options.onEvent;
  }

  isActive(id: string) {
    return this.claims.has(id) || this.active.has(id);
  }

  async listJobs() {
    return Promise.all((await this.repo.list()).map((job) => this.withCheckpointProgress(job)));
  }

  async getJob(id: string) {
    return this.withCheckpointProgress(await this.repo.get(id));
  }

  assertMutable(id: string, job?: PersistedJob) {
    if (this.isActive(id) || (job && ["running", "stopping", "analyzing"].includes(job.status)))
      throw new DomainError("job_active", "The job is active and cannot be modified", 409);
  }

  async analyze(id: string): Promise<PersistedJob> {
    if (this.claims.has(id) || this.active.has(id))
      throw new DomainError("job_active", "The job is already active", 409);
    this.claims.add(id);
    try {
      const job = await this.repo.get(id);
      if (["running", "stopping", "analyzing"].includes(job.status))
        throw new DomainError("job_active", "The job is already active", 409);
      const controller = new AbortController();
      const promise = this.scheduler
        .schedule(id, async () => {
          const analyzing = {
            ...job,
            status: "analyzing",
            stage: "analysis",
            updatedAt: new Date().toISOString(),
          };
          await this.repo.save(analyzing);
          await this.emit(id, "analysis_started", "Reading and preparing the EPUB");
          try {
            const prepared = await prepareBook(jobRoot(this.repo.dataDir, id));
            if (controller.signal.aborted) throw controller.signal.reason;
            const total = prepared.documents.reduce(
              (sum, document) => sum + document.batches.length,
              0,
            );
            const ready: PersistedJob = {
              ...job,
              status: "ready",
              stage: "analysis",
              progress: { translated: 0, edited: 0, total, failed: 0 },
              currentDocument: undefined,
              updatedAt: new Date().toISOString(),
            };
            await this.repo.save(ready);
            await this.emit(id, "analyzed", "Book analysis completed", { total });
          } catch (error) {
            await this.repo.save({
              ...job,
              status: controller.signal.aborted ? "paused" : "failed",
              stage: "analysis",
              updatedAt: new Date().toISOString(),
            });
            if (!controller.signal.aborted)
              await this.emit(id, "analysis_failed", "Book analysis failed", {
                error: redact(error instanceof Error ? error.message : "unknown error"),
              });
            throw error;
          }
        })
        .promise.then(() => undefined);
      this.active.set(id, { controller, promise, kind: "analysis" });
      this.claims.delete(id);
      try {
        await promise;
      } finally {
        this.active.delete(id);
      }
      return this.repo.get(id);
    } catch (error) {
      this.claims.delete(id);
      throw this.schedulerError(error);
    }
  }

  start(id: string): Promise<PersistedJob> {
    const pending = this.launches.get(id);
    if (pending) return pending;
    if (this.active.has(id)) return this.repo.get(id);
    const launch = this.launchStart(id);
    this.launches.set(id, launch);
    void launch
      .finally(() => {
        if (this.launches.get(id) === launch) this.launches.delete(id);
      })
      .catch(() => undefined);
    return launch;
  }

  private async launchStart(id: string): Promise<PersistedJob> {
    this.claims.add(id);
    try {
      const job = await this.repo.get(id);
      if (!["ready", "paused", "completed", "failed", "needs_attention"].includes(job.status))
        throw new DomainError(
          "job_not_startable",
          "Analyze the uploaded EPUB before starting",
          409,
        );
      const recoverCompatibleCheckpoints = ["paused", "failed", "needs_attention"].includes(
        job.status,
      );
      const root = jobRoot(this.repo.dataDir, id);
      const resumedProgress = recoverCompatibleCheckpoints
        ? await this.checkpointProgress(root, job)
        : { ...job.progress, translated: 0, edited: 0, failed: 0 };
      const controller = new AbortController();
      const running: PersistedJob = {
        ...job,
        status: "running",
        stage: recoverCompatibleCheckpoints ? job.stage : "translation",
        progress: resumedProgress,
        updatedAt: new Date().toISOString(),
      };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scheduled = this.scheduler.schedule(id, async () => {
        await gate;
        return this.execute(id, running, controller, recoverCompatibleCheckpoints);
      });
      const promise = scheduled.promise;
      this.active.set(id, { controller, promise, kind: "translation" });
      try {
        await this.repo.save(running);
      } catch (error) {
        controller.abort(error);
        release();
        throw error;
      }
      this.claims.delete(id);
      release();
      void promise
        .finally(() => {
          if (this.active.get(id)?.promise === promise) this.active.delete(id);
        })
        .catch(() => undefined);
      await this.emit(id, "started", "Translation started");
      return running;
    } catch (error) {
      this.claims.delete(id);
      throw this.schedulerError(error);
    }
  }

  async pause(id: string): Promise<PersistedJob> {
    const job = await this.repo.get(id),
      task = this.active.get(id);
    if (task) {
      const stopping: PersistedJob = {
        ...job,
        status: "stopping",
        updatedAt: new Date().toISOString(),
      };
      await this.repo.save(stopping);
      task.controller.abort(new Error("Job paused"));
      await this.emit(id, "pause_requested", "Pause requested");
      return stopping;
    }
    if (["running", "stopping", "analyzing"].includes(job.status)) {
      const paused: PersistedJob = {
        ...job,
        status: "paused",
        updatedAt: new Date().toISOString(),
      };
      await this.repo.save(paused);
      return paused;
    }
    if (job.status === "paused") return job;
    throw new DomainError("job_not_running", "Only an active job can be paused", 409);
  }

  async resume(id: string) {
    const job = await this.repo.get(id);
    if (job.status !== "paused" && !this.isActive(id))
      throw new DomainError("job_not_paused", "Only a paused job can be resumed", 409);
    const previous = this.active.get(id);
    if (previous && previous.controller.signal.aborted) {
      try {
        await previous.promise;
      } catch {
        /* an aborted run is expected */
      }
      this.active.delete(id);
    }
    if (job.stage === "analysis") return this.analyze(id);
    return this.start(id);
  }

  async retry(id: string) {
    const job = await this.repo.get(id);
    if (!["failed", "needs_attention", "paused"].includes(job.status))
      throw new DomainError("job_not_retryable", "The job has no retryable work", 409);
    if (job.stage === "analysis") return this.analyze(id);
    return this.start(id);
  }

  async invalidate(id: string, batchId?: string): Promise<PersistedJob> {
    const job = await this.repo.get(id);
    this.assertMutable(id, job);
    const root = jobRoot(this.repo.dataDir, id);
    const drafts = await this.filterJournal(join(root, "drafts.ndjson"), batchId);
    const edits = await this.filterJournal(join(root, "edits.ndjson"), batchId);
    await this.filterJournal(join(root, "audits.ndjson"), batchId);
    await this.filterJournal(join(root, "repairs.ndjson"), batchId);
    await rm(join(root, "quality-report.json"), { force: true });
    await rm(join(root, "output.epub"), { force: true });
    let prepared = true;
    try {
      await access(join(root, "prepared.json"));
    } catch {
      prepared = false;
    }
    const next: PersistedJob = {
      ...job,
      status: prepared ? "ready" : "created",
      stage: prepared ? "translation" : "import",
      progress: prepared
        ? { translated: drafts, edited: edits, total: job.progress.total, failed: 0 }
        : { translated: 0, edited: 0, total: 0, failed: 0 },
      currentDocument: undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.repo.save(next);
    await this.emit(
      id,
      "invalidated",
      "Completed work was invalidated",
      batchId ? { batchId } : undefined,
    );
    return next;
  }

  async invalidateQuality(id: string): Promise<PersistedJob> {
    const job = await this.repo.get(id);
    this.assertMutable(id, job);
    const root = jobRoot(this.repo.dataDir, id);
    const drafts = await readJournal<JournalRecord>(join(root, "drafts.ndjson"));
    const edits = await readJournal<JournalRecord>(join(root, "edits.ndjson"));
    await rm(join(root, "audits.ndjson"), { force: true });
    await rm(join(root, "repairs.ndjson"), { force: true });
    await rm(join(root, "quality-report.json"), { force: true });
    await rm(join(root, "output.epub"), { force: true });
    const next: PersistedJob = {
      ...job,
      status: "ready",
      stage: "translation",
      progress: {
        translated: new Set(drafts.map((record) => record.batchId)).size,
        edited: new Set(edits.map((record) => record.batchId)).size,
        total: job.progress.total,
        failed: 0,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.repo.save(next);
    await this.emit(
      id,
      "quality_invalidated",
      "Quality pass was reset; drafts and edits were kept",
    );
    return next;
  }

  async rebuild(id: string): Promise<{ job: PersistedJob; validation: ValidationReport }> {
    const job = await this.repo.get(id);
    this.assertMutable(id, job);
    if (!["completed", "ready", "failed", "paused"].includes(job.status))
      throw new DomainError(
        "job_not_rebuildable",
        "The job cannot be rebuilt in its current state",
        409,
      );
    const root = jobRoot(this.repo.dataDir, id),
      staging = join(root, "staging"),
      output = join(root, "output.epub"),
      temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await buildEpub(staging, temporary);
      const handle = await open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const validation = await validateEpubArchive(temporary);
      if (!validation.ok)
        throw new DomainError(
          "output_invalid",
          `Output validation failed: ${validation.errors.join(", ")}`,
          422,
        );
      await rename(temporary, output);
      await syncParentDirectory(output);
      const next: PersistedJob = {
        ...job,
        status: "completed",
        stage: "complete",
        updatedAt: new Date().toISOString(),
      };
      await this.repo.save(next);
      await this.emit(id, "rebuilt", "EPUB rebuilt");
      return { job: next, validation };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async results(id: string): Promise<JobResults> {
    await this.repo.get(id);
    const root = jobRoot(this.repo.dataDir, id),
      drafts = await readJournal<JournalRecord>(join(root, "drafts.ndjson")),
      edits = await readJournal<JournalRecord>(join(root, "edits.ndjson")),
      audits = await readJournal<JournalRecord>(join(root, "audits.ndjson")),
      repairs = await readJournal<JournalRecord>(join(root, "repairs.ndjson"));
    let outputAvailable = true;
    try {
      await access(join(root, "output.epub"));
    } catch {
      outputAvailable = false;
    }
    let validation: ValidationReport | null = null;
    try {
      validation = outputAvailable
        ? await validateEpubArchive(join(root, "output.epub"))
        : await validateEpub(join(root, "staging"));
    } catch {
      /* no prepared output */
    }
    const quality = await readJsonReport(join(root, "quality-report.json"));
    const consistency = await readJsonReport(join(root, "consistency-report.json"));
    return {
      validation,
      usage: await readUsageReport(root),
      quality: quality && {
        auditedSegments: count(quality.auditedSegments),
        flaggedSegments: count(quality.flaggedSegments),
        auditErrorSegments: count(quality.auditErrorSegments),
        auditErrorsByKind: {
          malformed_json: count(quality.auditErrorsByKind?.malformed_json),
          invalid_issues: count(quality.auditErrorsByKind?.invalid_issues),
        },
        rejectedRepairs: Array.isArray(quality.rejectedRepairs)
          ? quality.rejectedRepairs.length
          : 0,
      },
      consistency: consistency && {
        entities: count(consistency.entityStats?.kept),
        filteredEntities:
          count(consistency.entityStats?.stopWords) +
          count(consistency.entityStats?.commonWords) +
          count(consistency.entityStats?.weakEvidence) +
          count(consistency.entityStats?.overflow),
        chunks: count(consistency.chunks),
        resolvedChunks: count(consistency.resolvedChunks),
        failedChunks: Array.isArray(consistency.failedChunks) ? consistency.failedChunks.length : 0,
        decisions: Array.isArray(consistency.decisions) ? consistency.decisions.length : 0,
        applied: count(consistency.applied),
        mechanicalApplied: count(consistency.mechanicalApplied),
        glossaryAligned: count(consistency.glossaryAlignment?.applied),
        ignoredGlossaryEntries: Array.isArray(consistency.ignoredGlossaryEntries)
          ? consistency.ignoredGlossaryEntries.length
          : 0,
      },
      statistics: {
        translated: new Set(drafts.map((x) => x.batchId)).size,
        edited: new Set(edits.map((x) => x.batchId)).size,
        translationAttempts: drafts.reduce((n, x) => n + (x.attempts ?? 0), 0),
        editingAttempts: edits.reduce((n, x) => n + (x.attempts ?? 0), 0),
        auditAttempts: audits.reduce((n, x) => n + (x.attempts ?? 0), 0),
        repairAttempts: repairs.reduce((n, x) => n + (x.attempts ?? 0), 0),
        warnings: [...drafts, ...edits, ...audits, ...repairs].reduce(
          (n, x) => n + (x.warnings?.length ?? 0),
          0,
        ),
        outputAvailable,
      },
    };
  }

  private async checkpointProgress(root: string, job: PersistedJob) {
    const [drafts, edits] = await Promise.all([
      readJournal<JournalRecord>(join(root, "drafts.ndjson")),
      readJournal<JournalRecord>(join(root, "edits.ndjson")),
    ]);
    return {
      translated: new Set(drafts.map((record) => record.batchId)).size,
      edited: new Set(edits.map((record) => record.batchId)).size,
      total: job.progress.total,
      failed: 0,
    };
  }

  private async withCheckpointProgress(job: PersistedJob) {
    if (!["paused", "failed", "needs_attention"].includes(job.status)) return job;
    return {
      ...job,
      progress: await this.checkpointProgress(jobRoot(this.repo.dataDir, job.id), job),
    };
  }

  private async execute(
    id: string,
    running: PersistedJob,
    controller: AbortController,
    recoverCompatibleCheckpoints = false,
  ) {
    try {
      await this.emit(id, "execution_started", "Preparing translation workspace", {
        stage: running.stage,
      });
      const outcome = await this.runBook(
        jobRoot(this.repo.dataDir, id),
        running,
        async (patch) => {
          if (controller.signal.aborted) return;
          const current = await this.repo.get(id);
          if (current.status !== "running") return;
          const next = {
            ...current,
            ...patch,
            status: "running" as const,
            updatedAt: new Date().toISOString(),
          };
          await this.repo.save(next);
          if (patch.stage && patch.stage !== current.stage)
            await this.emit(id, "stage_changed", `Stage: ${patch.stage}`, { stage: patch.stage });
          if (
            patch.progress &&
            (patch.progress.translated !== current.progress.translated ||
              patch.progress.edited !== current.progress.edited)
          ) {
            const phase = patch.stage ?? current.stage;
            const completed =
              phase === "editing" ? patch.progress.edited : patch.progress.translated;
            await this.emit(
              id,
              "progress",
              `${phase} progress: ${completed}/${patch.progress.total}`,
              {
                stage: phase,
                completed,
                total: patch.progress.total,
                failed: patch.progress.failed,
              },
            );
          }
        },
        controller.signal,
        recoverCompatibleCheckpoints,
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      const current = await this.repo.get(id);
      // A book that was built without its consistency pass is finished, not correct.
      const degraded = degradedReasons(outcome);
      await this.repo.save({
        ...current,
        status: degraded.length ? "needs_attention" : "completed",
        stage: "complete",
        currentDocument: undefined,
        updatedAt: new Date().toISOString(),
      });
      if (degraded.length)
        await this.emit(id, "completed_with_warnings", "Translation completed with warnings", {
          reasons: degraded.map(redact),
        });
      else await this.emit(id, "completed", "Translation completed");
    } catch (error) {
      const current = await this.repo.get(id);
      if (controller.signal.aborted) {
        await this.repo.save({ ...current, status: "paused", updatedAt: new Date().toISOString() });
        await this.emit(id, "paused", "Translation paused");
      } else {
        await this.repo.save({ ...current, status: "failed", updatedAt: new Date().toISOString() });
        await this.emit(id, "failed", "Translation failed", {
          error: redact(error instanceof Error ? error.message : "unknown error"),
        });
      }
      throw error;
    }
  }

  private async filterJournal(path: string, batchId?: string) {
    const records = await readJournal<JournalRecord>(path),
      kept = batchId ? records.filter((x) => x.batchId !== batchId) : [];
    if (kept.length) await writeFile(path, kept.map((x) => JSON.stringify(x)).join("\n") + "\n");
    else await rm(path, { force: true });
    return new Set(kept.map((x) => x.batchId)).size;
  }

  private schedulerError(error: unknown) {
    return error instanceof Error && error.message === "Another job is already active"
      ? new DomainError("scheduler_busy", error.message, 409)
      : error;
  }
  private async emit(id: string, type: string, message: string, data?: Record<string, unknown>) {
    await this.onEvent?.(id, type, message, data);
  }
}
