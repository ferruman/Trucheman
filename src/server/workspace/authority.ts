/**
 * The job side of DELEGATION.md §2: a job launched under a delegation carries it (`job.authority`), and the
 * delegation is read again before every new paid dispatch — the start, a resume or retry, and each model call.
 * Work already sent is not undone by a later expiry; the next call is what needs authority.
 */
import { DomainError } from "../domain/errors.js";
import type { PersistedJob } from "../domain/job.js";
import { delegationHash, delegationProblem } from "../mcp/authority.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/** Why the job's persisted authority no longer covers new paid work; null when it does (or a person runs it). */
export async function authorityLapse(job: PersistedJob, now = Date.now()): Promise<string | null> {
  const a = job.authority;
  if (a?.authority !== "delegated") return null;
  if (!job.workspace) return "the job claims a delegation but names no workspace to read it from";
  const why = await delegationProblem(job.workspace.path, a.delegation_id, a.capability, now);
  if (why) return why;
  // An entry edited since the job was authorized is not the grant it ran under (DELEGATION.md §4).
  const config = (parseYaml(await readFile(join(job.workspace.path, "codicora.yaml"), "utf8")) ?? {}) as { authority?: { path?: string } };
  const doc = JSON.parse(await readFile(join(resolve(job.workspace.path, config.authority?.path ?? "./authority"), "delegations.json"), "utf8")) as { delegations?: Array<{ id?: string }> };
  const entry = doc.delegations?.find((d) => d?.id === a.delegation_id);
  if (entry && delegationHash(entry) !== a.delegation_hash) return `Delegation "${a.delegation_id}" was edited after this job was authorized; the author decides whether it continues.`;
  return null;
}

export async function assertAuthority(job: PersistedJob): Promise<void> {
  const why = await authorityLapse(job);
  if (why)
    throw new DomainError(
      "authority_lapsed",
      `No new paid work for this job: ${why} Continue it with confirm: true after the author agrees, or under a delegation that covers ${job.authority?.authority === "delegated" ? job.authority.capability : "it"}.`,
      409,
    );
}
