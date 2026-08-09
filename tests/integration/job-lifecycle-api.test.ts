import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJobConfig } from "../../src/server/api/jobs.js";
import type { PersistedJob } from "../../src/server/domain/job.js";
import { JobOrchestrator } from "../../src/server/jobs/job-orchestrator.js";
import { JobRepository } from "../../src/server/storage/job-repository.js";

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
    documents: [],
    instructions: "",
    glossary: [],
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
    await vi.waitFor(() => expect(invocations).toBe(1));
    expect((await orchestrator.pause(job.id)).status).toBe("stopping");
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("paused"));
    expect((await orchestrator.resume(job.id)).status).toBe("running");
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("completed"));
    expect(invocations).toBe(2);
  });

  it("rejects malformed config without corrupting the persisted job", async () => {
    const { repo, job } = await fixture("created");
    expect(() => parseJobConfig({ instructions: {} })).toThrow();
    expect((await repo.get(job.id)).instructions).toBe("");
  });

  it("does not report fatal execution errors as quality warnings", async () => {
    const { repo, job } = await fixture();
    const orchestrator = new JobOrchestrator(repo, {
      runBook: async () => {
        throw new Error("assembly failed");
      },
    });
    await orchestrator.start(job.id);
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("failed"));
    expect((await repo.get(job.id)).warnings).toBe(0);
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
    await vi.waitFor(async () => expect((await repo.get(job.id)).status).toBe("failed"));
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
