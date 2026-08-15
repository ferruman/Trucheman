import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJobConfig } from "../../src/server/api/jobs.js";
import type { PersistedJob } from "../../src/server/domain/job.js";
import { JobOrchestrator } from "../../src/server/jobs/job-orchestrator.js";
import { JobRepository } from "../../src/server/storage/job-repository.js";
import { jobRoot } from "../../src/server/storage/job-paths.js";

const roots: string[] = [];
const orchestrators: JobOrchestrator[] = [];
afterEach(async () => {
  // A settled status does not mean the run stopped writing; removing the data directory
  // under a task that is still saving is what made this suite flaky.
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.drain();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function orchestratorFor(...args: ConstructorParameters<typeof JobOrchestrator>) {
  const orchestrator = new JobOrchestrator(...args);
  orchestrators.push(orchestrator);
  return orchestrator;
}

async function fixture(status = "ready") {
  const dataDir = await mkdtemp(`${tmpdir()}/book-lifecycle-`);
  roots.push(dataDir);
  const repo = new JobRepository(dataDir),
    now = new Date().toISOString();
  const job: PersistedJob = {
    version: 1,
    id: "12345678-1234-4234-8234-123456789012",
    title: "Book",
    sourceLanguage: "en",
    targetLanguage: "ru",
    status,
    stage: "translation",
    progress: { translated: 0, edited: 0, total: 1, failed: 0 },
    createdAt: now,
    updatedAt: now,
    warnings: 0,
    instructions: "",
    glossary: [],
    qualityMode: "standard",
  };
  await repo.save(job);
  return { repo, job };
}

describe("job lifecycle orchestration", () => {
  it("coalesces concurrent starts and durably pauses and resumes one task", async () => {
    const { repo, job } = await fixture();
    let invocations = 0;
    const orchestrator = orchestratorFor(repo, {
      runBook: async (_root, _job, _update, signal) => {
        invocations++;
        if (invocations === 1)
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
      },
    });

    const [first, second] = await Promise.all([
      orchestrator.start(job.id),
      orchestrator.start(job.id),
    ]);
    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    await vi.waitFor(() => expect(invocations).toBe(1), { timeout: 5000 });
    expect((await orchestrator.pause(job.id)).status).toBe("stopping");
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("paused"), {
      timeout: 5000,
    });
    expect((await orchestrator.resume(job.id)).status).toBe("running");
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("completed"), {
      timeout: 5000,
    });
    expect(invocations).toBe(2);
  });

  it("reconstructs progress and enables compatible checkpoints after a failure", async () => {
    const { repo, job } = await fixture("failed");
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    await repo.save({ ...job, status: "failed", progress: { ...job.progress, total: 3 } });
    await writeFile(
      `${root}/drafts.ndjson`,
      ["batch-1", "batch-2"]
        .map((batchId) => JSON.stringify({ batchId, segments: [] }))
        .join("\n") + "\n",
    );
    await writeFile(
      `${root}/edits.ndjson`,
      `${JSON.stringify({ batchId: "batch-1", segments: [] })}\n`,
    );
    let receivedJob: PersistedJob | undefined;
    let compatibleRecovery: boolean | undefined;
    const orchestrator = orchestratorFor(repo, {
      runBook: async (_root, running, _update, _signal, recoverCompatibleCheckpoints) => {
        receivedJob = running;
        compatibleRecovery = recoverCompatibleCheckpoints;
      },
    });

    expect((await orchestrator.getJob(job.id)).progress).toEqual({
      translated: 2,
      edited: 1,
      total: 3,
      failed: 0,
    });

    const running = await orchestrator.start(job.id);
    await vi.waitFor(() => expect(receivedJob).toBeDefined(), { timeout: 5000 });

    expect(running.progress).toEqual({ translated: 2, edited: 1, total: 3, failed: 0 });
    expect(receivedJob?.progress).toEqual(running.progress);
    expect(compatibleRecovery).toBe(true);
  });

  it("keeps the checkpoints of the batches an invalidation did not touch", async () => {
    // Invalidating one batch leaves the job `ready`. Gating recovery on the status withdrew
    // it from every other batch, and each block whose instructions had drifted since it was
    // translated — a chapter card that arrived on a later run — was paid for again.
    const { repo, job } = await fixture();
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/prepared.json`, "{}");
    await writeFile(
      `${root}/drafts.ndjson`,
      ["batch-1", "batch-2"]
        .map((batchId) => JSON.stringify({ batchId, segments: [] }))
        .join("\n") + "\n",
    );
    let compatibleRecovery: boolean | undefined;
    const orchestrator = orchestratorFor(repo, {
      runBook: async (_root, _running, _update, _signal, recoverCompatibleCheckpoints) => {
        compatibleRecovery = recoverCompatibleCheckpoints;
      },
    });

    const invalidated = await orchestrator.invalidate(job.id, "batch-1");
    expect(invalidated.status).toBe("ready");

    await orchestrator.start(job.id);
    await vi.waitFor(() => expect(compatibleRecovery).toBeDefined(), { timeout: 5000 });

    expect(compatibleRecovery).toBe(true);
  });

  it("rejects malformed config without corrupting the persisted job", async () => {
    const { repo, job } = await fixture("created");
    expect(() => parseJobConfig({ instructions: {} })).toThrow();
    expect((await repo.get(job.id)).instructions).toBe("");
  });

  it("accepts only supported per-book quality modes", () => {
    expect(parseJobConfig({ qualityMode: "high" })).toEqual({ qualityMode: "high" });
    expect(() => parseJobConfig({ qualityMode: "maximum" })).toThrow();
  });

  it("re-decides entity renderings only when the whole job is invalidated", async () => {
    const { repo, job } = await fixture();
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    const settled = ["entity-registry.json", "consistency-resolution.json"];
    const write = () =>
      Promise.all([
        ...settled.map((name) => writeFile(`${root}/${name}`, "{}")),
        writeFile(`${root}/drafts.ndjson`, `${JSON.stringify({ batchId: "b1", segments: [] })}\n`),
      ]);
    const orchestrator = orchestratorFor(repo);

    await write();
    await orchestrator.invalidate(job.id, "b1");
    // Re-deciding for one batch would rename entities across the batches being kept.
    for (const name of settled) await expect(access(`${root}/${name}`)).resolves.toBeUndefined();

    await write();
    await orchestrator.invalidate(job.id, undefined, "editing");
    // Re-editing keeps the drafts that already used those renderings.
    for (const name of settled) await expect(access(`${root}/${name}`)).resolves.toBeUndefined();

    await write();
    await orchestrator.invalidate(job.id);
    for (const name of settled) await expect(access(`${root}/${name}`)).rejects.toThrow();
  });

  it("keeps an edited style profile under the key the next run looks up", async () => {
    const { repo, job } = await fixture();
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    await writeFile(
      `${root}/drafts.ndjson`,
      `${JSON.stringify({ batchId: "b1", segments: [] })}\n`,
    );
    await writeFile(`${root}/entity-registry.json`, "{}");
    const orchestrator = orchestratorFor(repo);

    // Nothing to edit before a run has produced one: a profile written under a made-up cache
    // key would be re-asked and overwritten by the next run.
    await expect(orchestrator.saveStyleProfile(job.id, { genre: "noir" })).rejects.toThrow(
      /nothing to edit/i,
    );

    await writeFile(
      `${root}/style-profile.json`,
      JSON.stringify({ key: "cache-key", value: { genre: "romance" } }),
    );
    expect(await orchestrator.styleProfile(job.id)).toEqual({ genre: "romance" });

    expect(
      await orchestrator.saveStyleProfile(job.id, { genre: "noir", notes: ["clipped"] }),
    ).toEqual({ genre: "noir", notes: ["clipped"] });
    expect(JSON.parse(await readFile(`${root}/style-profile.json`, "utf8"))).toEqual({
      key: "cache-key",
      value: { genre: "noir", notes: ["clipped"] },
    });
    // The block reaches every stage, so the completed work no longer matches the profile.
    await expect(access(`${root}/drafts.ndjson`)).rejects.toThrow();
    await expect(access(`${root}/entity-registry.json`)).rejects.toThrow();
    expect((await repo.get(job.id)).status).toBe("created");
  });

  it("stops recovering positional checkpoints when the source EPUB changed", async () => {
    const { repo, job } = await fixture("paused");
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/source.epub`, "first book");
    const recoveries: (boolean | undefined)[] = [];
    const orchestrator = orchestratorFor(repo, {
      runBook: async (_root, _job, _update, _signal, recover) => {
        recoveries.push(recover);
      },
    });

    await orchestrator.start(job.id);
    await vi.waitFor(() => expect(recoveries).toHaveLength(1), { timeout: 5000 });
    // The first run has no stored fingerprint to compare against, so recovery stays available.
    expect(recoveries[0]).toBe(true);
    expect((await repo.get(job.id)).sourceFingerprint).toEqual(expect.any(String));

    await orchestrator.drain();
    await repo.save({ ...(await repo.get(job.id)), status: "paused" });
    await writeFile(`${root}/source.epub`, "a different book");
    await orchestrator.start(job.id);

    await vi.waitFor(() => expect(recoveries).toHaveLength(2), { timeout: 5000 });
    // Batch and segment ids are positional: reusing them here would hand the new text a
    // translation of the old book.
    expect(recoveries[1]).toBe(false);
  });

  it("derives outcome and advisory counters from a legacy quality report", async () => {
    const { repo, job } = await fixture();
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    await writeFile(
      `${root}/quality-report.json`,
      JSON.stringify({
        version: 4,
        auditedSegments: 1768,
        flaggedSegments: 107,
        repairedSegments: 89,
        rejectedRepairs: [{ batchId: "batch-1", id: "s1" }],
        unrepairedSegments: Array.from({ length: 17 }, (_, index) => ({
          batchId: "batch-1",
          id: `unchanged-${index}`,
        })),
        scan: {
          defectSegments: 5,
          defects: Array.from({ length: 5 }, (_, index) => ({
            id: `residue-${index}`,
            kind: "source_residue",
          })),
        },
      }),
    );

    const results = await orchestratorFor(repo).results(job.id);

    expect(results.quality).toMatchObject({
      flaggedSegments: 107,
      repairedSegments: 89,
      remainingFlaggedSegments: 18,
      unchangedRepairs: 17,
      scanDefectSegments: 0,
      advisoryScanDefectSegments: 5,
    });
  });

  it("discards only the stages at or below the invalidation floor", async () => {
    const { repo, job } = await fixture();
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    const checkpoint = `${JSON.stringify({ batchId: "batch-1", segments: [] })}\n`;
    const seed = () =>
      Promise.all([
        ...["drafts.ndjson", "edits.ndjson", "audits.ndjson", "repairs.ndjson"].map((name) =>
          writeFile(`${root}/${name}`, checkpoint),
        ),
        writeFile(`${root}/prepared.json`, "{}"),
        writeFile(`${root}/quality-report.json`, "{}"),
        writeFile(`${root}/output.epub`, "output"),
      ]);
    const orchestrator = orchestratorFor(repo);

    await seed();
    expect(await orchestrator.invalidate(job.id, undefined, "audit")).toMatchObject({
      status: "ready",
      progress: { translated: 1, edited: 1, total: 1, failed: 0 },
    });
    expect(await readFile(`${root}/drafts.ndjson`, "utf8")).toBe(checkpoint);
    expect(await readFile(`${root}/edits.ndjson`, "utf8")).toBe(checkpoint);
    await expect(access(`${root}/audits.ndjson`)).rejects.toThrow();
    await expect(access(`${root}/repairs.ndjson`)).rejects.toThrow();
    await expect(access(`${root}/quality-report.json`)).rejects.toThrow();
    await expect(access(`${root}/output.epub`)).rejects.toThrow();

    await seed();
    expect(await orchestrator.invalidate(job.id, undefined, "editing")).toMatchObject({
      status: "ready",
      progress: { translated: 1, edited: 0, total: 1, failed: 0 },
    });
    expect(await readFile(`${root}/drafts.ndjson`, "utf8")).toBe(checkpoint);
    await expect(access(`${root}/edits.ndjson`)).rejects.toThrow();
    await expect(access(`${root}/audits.ndjson`)).rejects.toThrow();

    await seed();
    expect(await orchestrator.invalidate(job.id)).toMatchObject({
      status: "ready",
      progress: { translated: 0, edited: 0, total: 1, failed: 0 },
    });
    await expect(access(`${root}/drafts.ndjson`)).rejects.toThrow();
  });

  it("does not report fatal execution errors as quality warnings", async () => {
    const { repo, job } = await fixture();
    const orchestrator = orchestratorFor(repo, {
      runBook: async () => {
        throw new Error("assembly failed");
      },
    });
    await orchestrator.start(job.id);
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("failed"), {
      timeout: 5000,
    });
    expect((await repo.get(job.id)).warnings).toBe(0);
  });

  it("does not report a run that skipped its consistency pass as completed", async () => {
    const { repo, job } = await fixture(),
      events: { type: string; data?: Record<string, unknown> }[] = [];
    const orchestrator = orchestratorFor(repo, {
      runBook: async () => ({
        ok: true,
        degraded: ["Consistency resolver unavailable: Provider request timed out"],
      }),
      onEvent: async (_id, type, _message, data) => {
        events.push({ type, data });
      },
    });
    await orchestrator.start(job.id);
    // The status is saved before the event is emitted, so waiting on the status would race
    // the event this test is about.
    await vi.waitFor(
      () => expect(events.map(({ type }) => type)).toContain("completed_with_warnings"),
      {
        timeout: 5000,
      },
    );
    expect((await repo.get(job.id)).status).toBe("needs_attention");

    // The book is still built, so the stage is complete and the output stays downloadable.
    expect((await repo.get(job.id)).stage).toBe("complete");
    expect(events).toContainEqual({
      type: "completed_with_warnings",
      data: { reasons: ["Consistency resolver unavailable: Provider request timed out"] },
    });
  });

  it("reports a clean run as completed", async () => {
    const { repo, job } = await fixture();
    const orchestrator = orchestratorFor(repo, {
      runBook: async () => ({ ok: true, degraded: [] }),
    });
    await orchestrator.start(job.id);
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("completed"), {
      timeout: 5000,
    });
  });

  it("requires attention when a high semantic critic finding survives repair", async () => {
    const { repo, job } = await fixture();
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    const orchestrator = orchestratorFor(repo, {
      runBook: async () => {
        await writeFile(
          `${root}/quality-report.json`,
          JSON.stringify({
            scan: { defects: [] },
            unresolvedFindings: [
              {
                id: "document-21:aa",
                issues: [{ type: "semantic_error", severity: "high" }],
              },
            ],
          }),
        );
        return { ok: true, degraded: [] };
      },
    });

    await orchestrator.start(job.id);
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("needs_attention"), {
      timeout: 5000,
    });
    expect((await repo.get(job.id)).stage).toBe("complete");
  });

  it("emits a readable, redacted failure event", async () => {
    const { repo, job } = await fixture(),
      events: { type: string; message: string; data?: Record<string, unknown> }[] = [];
    const orchestrator = orchestratorFor(repo, {
      runBook: async () => {
        throw new Error("authorization: Bearer sk-sentinel12345");
      },
      onEvent: async (_id, type, message, data) => {
        events.push({ type, message, data });
      },
    });
    await orchestrator.start(job.id);
    await vi.waitFor(() => expect(events.map(({ type }) => type)).toContain("failed"), {
      timeout: 5000,
    });
    expect((await repo.get(job.id)).status).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "execution_started",
        message: "Preparing translation workspace",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "failed",
        message: "Translation failed",
        data: { error: "authorization=[redacted] [redacted]" },
      }),
    );
  });
});
