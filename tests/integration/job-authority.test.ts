import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedJob } from "../../src/server/domain/job.js";
import { JobOrchestrator } from "../../src/server/jobs/job-orchestrator.js";
import { JobRepository } from "../../src/server/storage/job-repository.js";
import { UsageTrackingProvider } from "../../src/server/jobs/usage-service.js";
import { assertAuthority } from "../../src/server/workspace/authority.js";
import { delegationHash } from "../../src/server/mcp/authority.js";

/**
 * Audit 2026-10-06: a job launched under a delegation must not become ambient permission. Each new paid dispatch —
 * the start, a resume or retry, every model call — re-reads the delegation; an expired or revoked one refuses it.
 */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(over: Record<string, unknown> = {}) {
  const ws = await mkdtemp(join(tmpdir(), "trucheman-auth-ws-"));
  const dataDir = await mkdtemp(join(tmpdir(), "trucheman-auth-data-"));
  roots.push(ws, dataDir);
  await mkdir(join(ws, "authority"));
  await writeFile(join(ws, "codicora.yaml"), "spec: codicora/v1\nproject:\n  id: book\n");
  const entry = { id: "run", workspace: "book", granted_by: "author", granted_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), allow: ["trucheman.translate"], limits: { max_spend: 10, currency: "USD" }, ...over };
  const write = (e: Record<string, unknown>) => writeFile(join(ws, "authority", "delegations.json"), JSON.stringify({ schema: "codicora.delegations/0.1", delegations: [e] }));
  await write(entry);
  const repo = new JobRepository(dataDir);
  const now = new Date().toISOString();
  const job: PersistedJob = {
    version: 1, id: "12345678-1234-4234-8234-123456789012", title: "Book", sourceLanguage: "en", targetLanguage: "ru",
    status: "paused", stage: "translation", progress: { translated: 0, edited: 0, total: 1, failed: 0 }, createdAt: now, updatedAt: now,
    warnings: 0, instructions: "", glossary: [], qualityMode: "standard", epubRepaired: false,
    workspace: { path: ws, text: "manuscript", sourceHash: "sha256:x" },
    authority: { authority: "delegated", performed_by: "mcp:codex", authorized_by: "author", delegation_id: "run", delegation_hash: delegationHash(entry), capability: "trucheman.translate" },
  } as PersistedJob;
  await repo.save(job);
  return { ws, repo, job, entry, write };
}

describe("persisted job authority", () => {
  it("a valid delegation lets the paused job's next dispatch through", async () => {
    const { job } = await setup();
    await expect(assertAuthority(job)).resolves.toBeUndefined();
  });

  it("expired after launch: resume and retry are refused before any new paid work", async () => {
    const { repo, job, entry, write } = await setup();
    await write({ ...entry, expires_at: new Date(Date.now() - 1000).toISOString() });
    const orchestrator = new JobOrchestrator(repo, { runBook: async () => { throw new Error("must not run"); } });
    await expect(orchestrator.resume(job.id)).rejects.toThrow(/authority_lapsed|No new paid work.*expired/);
    await expect(orchestrator.retry(job.id)).rejects.toThrow(/No new paid work.*expired/);
    expect((await repo.get(job.id)).status).toBe("paused");
  });

  it("revoked mid-run: the next model call is refused before it is sent", async () => {
    const { job, entry, write } = await setup();
    let sent = 0;
    const request = { segments: [{ id: "s1", text: "x" }], profile: { name: "translation", model: "m" } } as never;
    const provider = new UsageTrackingProvider({ complete: async () => { sent++; return { segments: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as never; } }, await mkdtemp(join(tmpdir(), "usage-")), undefined, () => assertAuthority(job));
    await provider.complete(request);
    expect(sent).toBe(1);
    await write({ ...entry, revoked_at: new Date(Date.now() - 1000).toISOString() });
    await expect(provider.complete(request)).rejects.toThrow(/was revoked/);
    expect(sent).toBe(1);
  });

  it("an entry edited after launch (budget raised) is not the grant the job ran under", async () => {
    const { job, entry, write } = await setup();
    await write({ ...entry, limits: { max_spend: 1000, currency: "USD" } });
    await expect(assertAuthority(job)).rejects.toThrow(/edited after this job was authorized/);
  });

  it("a job a person started carries no delegation and is not affected", async () => {
    const { job } = await setup({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(assertAuthority({ ...job, authority: undefined })).resolves.toBeUndefined();
    await expect(assertAuthority({ ...job, authority: { authority: "direct", performed_by: "mcp:codex" } })).resolves.toBeUndefined();
  });
});
