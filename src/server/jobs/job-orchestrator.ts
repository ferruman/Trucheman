import { createHash, randomUUID } from "node:crypto";
import { access, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PersistedJob } from "../domain/job.js";
import type { InvalidationStage } from "../../shared/domain/job.js";
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
import { styleProfileSchema, type StyleProfile } from "./style-profile-service.js";
import { writeCache } from "./consistency-service.js";

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
    /** Deterministic per-segment findings; produced in both quality modes. */
    scanDefectSegments: number;
    scanDefectsByKind: Record<string, number>;
    /** Batches the last run replayed from a checkpoint instead of paying for again. */
    cachedCheckpoints: { translation: number; editing: number; audit: number; repair: number };
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
    /** Quote and ё findings; the rest of what the job's warning counter is made of. */
    documentWarnings: number;
    /** Passes the run finished without, verbatim. */
    errors: string[];
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

  /**
   * Wait until no task is still writing. A run keeps saving state and emitting events after
   * the status it reports has already settled, so anything that touches the data directory
   * next — a shutdown, a test's cleanup — has to wait for the writes, not for the status.
   */
  async drain() {
    while (this.active.size || this.launches.size) {
      await Promise.allSettled([...this.launches.values()]);
      await Promise.allSettled([...this.active.values()].map((task) => task.promise));
    }
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
      const root = jobRoot(this.repo.dataDir, id);
      const fingerprint = await this.sourceFingerprint(root);
      // A keyed checkpoint is content-addressed and safe on its own. The by-batch-id recovery
      // below is not: it matches on positional ids, so a source replaced under a paused job
      // would hand the new text a translation of the old one.
      const sameSource =
        job.sourceFingerprint === undefined || job.sourceFingerprint === fingerprint;
      const recoverCompatibleCheckpoints =
        ["paused", "failed", "needs_attention"].includes(job.status) && sameSource;
      if (!sameSource)
        await this.emit(
          id,
          "source_changed",
          "The source EPUB changed since the last run; checkpoints are reused only where the text still matches",
        );
      const resumedProgress = recoverCompatibleCheckpoints
        ? await this.checkpointProgress(root, job)
        : { ...job.progress, translated: 0, edited: 0, failed: 0 };
      const controller = new AbortController();
      const running: PersistedJob = {
        ...job,
        status: "running",
        stage: recoverCompatibleCheckpoints ? job.stage : "translation",
        progress: resumedProgress,
        sourceFingerprint: fingerprint ?? job.sourceFingerprint,
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

  /**
   * Rewind the pipeline to `from` and below. A stage above it keeps its journal, so the next
   * run replays it from the checkpoint instead of paying for it again: `editing` re-edits the
   * drafts that are already there, `audit` keeps drafts and edits and only re-runs the critic.
   */
  async invalidate(
    id: string,
    batchId?: string,
    from: InvalidationStage = "translation",
  ): Promise<PersistedJob> {
    const job = await this.repo.get(id);
    this.assertMutable(id, job);
    const root = jobRoot(this.repo.dataDir, id);
    const drafts =
      from === "translation"
        ? await this.filterJournal(join(root, "drafts.ndjson"), batchId)
        : await this.countJournal(join(root, "drafts.ndjson"));
    const edits =
      from === "audit"
        ? await this.countJournal(join(root, "edits.ndjson"))
        : await this.filterJournal(join(root, "edits.ndjson"), batchId);
    await this.filterJournal(join(root, "audits.ndjson"), batchId);
    await this.filterJournal(join(root, "repairs.ndjson"), batchId);
    await rm(join(root, "quality-report.json"), { force: true });
    await rm(join(root, "output.epub"), { force: true });
    if (!batchId && from === "translation") {
      // Settled entity answers outlive code and model changes on purpose, so invalidating
      // the whole job — every batch, from the translation down — is the only way to ask for
      // new ones. Re-deciding for a single batch, or for a re-edit of drafts that already
      // used those renderings, would rename entities across everything being kept.
      await rm(join(root, "entity-registry.json"), { force: true });
      await rm(join(root, "consistency-resolution.json"), { force: true });
      await rm(join(root, "consistency-report.json"), { force: true });
    }
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
    await this.emit(id, "invalidated", `Completed work was invalidated from ${from}`, {
      from,
      ...(batchId ? { batchId } : {}),
    });
    return next;
  }

  /** The generated profile as the last run used it, or null when no run has produced one. */
  async styleProfile(id: string): Promise<StyleProfile | null> {
    await this.repo.get(id);
    const cached = await readJsonReport(join(jobRoot(this.repo.dataDir, id), "style-profile.json"));
    const parsed = styleProfileSchema.safeParse(cached?.value);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Replace the generated profile with the user's reading of the book. It is written under the
   * cache key the run computed, so the next run reads it back instead of re-asking the model —
   * and because the profile block reaches every stage, editing it invalidates the whole job.
   */
  async saveStyleProfile(id: string, profile: StyleProfile): Promise<StyleProfile> {
    const job = await this.repo.get(id);
    this.assertMutable(id, job);
    const path = join(jobRoot(this.repo.dataDir, id), "style-profile.json");
    const cached = await readJsonReport(path);
    if (typeof cached?.key !== "string")
      throw new DomainError(
        "style_profile_missing",
        "The style profile is generated by the first run against a real provider; there is nothing to edit yet",
        409,
      );
    await writeCache(path, cached.key, profile);
    await this.invalidate(id);
    await this.emit(id, "style_profile_edited", "The book style profile was edited by hand");
    return profile;
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
        scanDefectSegments: count(quality.scan?.defectSegments),
        scanDefectsByKind: quality.scan?.defectsByKind ?? {},
        cachedCheckpoints: {
          translation: count(quality.cachedCheckpoints?.translation),
          editing: count(quality.cachedCheckpoints?.editing),
          audit: count(quality.cachedCheckpoints?.audit),
          repair: count(quality.cachedCheckpoints?.repair),
        },
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
        documentWarnings: count(consistency.warningCount),
        errors: Array.isArray(consistency.errors)
          ? consistency.errors.filter((error: unknown) => typeof error === "string").map(redact)
          : [],
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
      // Each patch is a read-modify-write of the whole job. Batches run concurrently, so
      // without this chain two interleaved patches can drop the later progress count.
      let pending: Promise<void> = Promise.resolve();
      const applyPatch = async (patch: Partial<PersistedJob>) => {
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
          const completed = phase === "editing" ? patch.progress.edited : patch.progress.translated;
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
      };
      const outcome = await this.runBook(
        jobRoot(this.repo.dataDir, id),
        running,
        (patch) => {
          const applied = pending.then(() => applyPatch(patch));
          // A failed patch is the caller's to handle; the chain itself keeps going.
          pending = applied.catch(() => {});
          return applied;
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

  /** Undefined when there is no source yet: a job that has never had one cannot have changed. */
  private async sourceFingerprint(root: string) {
    try {
      return createHash("sha256")
        .update(await readFile(join(root, "source.epub")))
        .digest("hex");
    } catch {
      return undefined;
    }
  }

  /** Batches a kept journal still covers — the progress a partial invalidation carries over. */
  private async countJournal(path: string) {
    const records = await readJournal<JournalRecord>(path);
    return new Set(records.map((record) => record.batchId)).size;
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
