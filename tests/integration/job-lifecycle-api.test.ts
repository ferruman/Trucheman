import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJobConfig } from "../../src/server/api/jobs.js";
import type { PersistedJob } from "../../src/server/domain/job.js";
import { JobOrchestrator } from "../../src/server/jobs/job-orchestrator.js";
import { JobRepository } from "../../src/server/storage/job-repository.js";
import { jobRoot } from "../../src/server/storage/job-paths.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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
    const orchestrator = new JobOrchestrator(repo, {
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
    const orchestrator = new JobOrchestrator(repo, {
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

  it("rejects malformed config without corrupting the persisted job", async () => {
    const { repo, job } = await fixture("created");
    expect(() => parseJobConfig({ instructions: {} })).toThrow();
    expect((await repo.get(job.id)).instructions).toBe("");
  });

  it("accepts only supported per-book quality modes", () => {
    expect(parseJobConfig({ qualityMode: "high" })).toEqual({ qualityMode: "high" });
    expect(() => parseJobConfig({ qualityMode: "maximum" })).toThrow();
  });

  it("resets only quality work when switching quality modes", async () => {
    const { repo, job } = await fixture();
    const root = jobRoot(repo.dataDir, job.id);
    await mkdir(root, { recursive: true });
    const checkpoint = `${JSON.stringify({ batchId: "batch-1", segments: [] })}\n`;
    await Promise.all(
      ["drafts.ndjson", "edits.ndjson", "audits.ndjson", "repairs.ndjson"].map((name) =>
        writeFile(`${root}/${name}`, checkpoint),
      ),
    );
    await writeFile(`${root}/quality-report.json`, "{}");
    await writeFile(`${root}/output.epub`, "output");
    const orchestrator = new JobOrchestrator(repo);

    const next = await orchestrator.invalidateQuality(job.id);

    expect(next).toMatchObject({
      status: "ready",
      progress: { translated: 1, edited: 1, total: 1, failed: 0 },
    });
    expect(await readFile(`${root}/drafts.ndjson`, "utf8")).toBe(checkpoint);
    expect(await readFile(`${root}/edits.ndjson`, "utf8")).toBe(checkpoint);
    await expect(access(`${root}/audits.ndjson`)).rejects.toThrow();
    await expect(access(`${root}/repairs.ndjson`)).rejects.toThrow();
    await expect(access(`${root}/quality-report.json`)).rejects.toThrow();
    await expect(access(`${root}/output.epub`)).rejects.toThrow();
  });

  it("does not report fatal execution errors as quality warnings", async () => {
    const { repo, job } = await fixture();
    const orchestrator = new JobOrchestrator(repo, {
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
    const orchestrator = new JobOrchestrator(repo, {
      runBook: async () => ({
        ok: true,
        degraded: ["Consistency resolver unavailable: Provider request timed out"],
      }),
      onEvent: async (_id, type, _message, data) => {
        events.push({ type, data });
      },
    });
    await orchestrator.start(job.id);
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("needs_attention"), {
      timeout: 5000,
    });

    // The book is still built, so the stage is complete and the output stays downloadable.
    expect((await repo.get(job.id)).stage).toBe("complete");
    expect(events).toContainEqual({
      type: "completed_with_warnings",
      data: { reasons: ["Consistency resolver unavailable: Provider request timed out"] },
    });
  });

  it("reports a clean run as completed", async () => {
    const { repo, job } = await fixture();
    const orchestrator = new JobOrchestrator(repo, {
      runBook: async () => ({ ok: true, degraded: [] }),
    });
    await orchestrator.start(job.id);
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("completed"), {
      timeout: 5000,
    });
  });

  it("emits a readable, redacted failure event", async () => {
    const { repo, job } = await fixture(),
      events: { type: string; message: string; data?: Record<string, unknown> }[] = [];
    const orchestrator = new JobOrchestrator(repo, {
      runBook: async () => {
        throw new Error("authorization: Bearer sk-sentinel12345");
      },
      onEvent: async (_id, type, message, data) => {
        events.push({ type, message, data });
      },
    });
    await orchestrator.start(job.id);
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("failed"), {
      timeout: 5000,
    });
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
