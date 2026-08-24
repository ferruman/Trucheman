import { access } from "node:fs/promises";
import { join } from "node:path";
import type { PersistedJob } from "../domain/job.js";
import { atomicJson } from "../storage/atomic-file.js";
import { readJournal } from "../storage/ndjson-journal.js";

const PREPARATION_VERSION = 1;
const MANIFEST_VERSION = 1;

type JournalRecord = { batchId?: unknown };
type UnitState = { completed: number; total: number; pending: number };

export type RunManifest = {
  version: 1;
  sourceFingerprint: string | null;
  preparationVersion: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  stage: string;
  recovery: { eligible: boolean; reason: string };
  units: {
    translation: UnitState;
    editing: UnitState;
    audit: UnitState;
    repair: UnitState;
  };
};

function countCompleted(records: JournalRecord[]) {
  return new Set(
    records.flatMap((record) => (typeof record.batchId === "string" ? [record.batchId] : [])),
  ).size;
}

function unitState(completed: number, total: number): UnitState {
  return { completed, total, pending: Math.max(0, total - completed) };
}

async function isPrepared(root: string) {
  try {
    await access(join(root, "prepared.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * A small, inspectable run contract. Journals remain the source of truth; this records the
 * immutable inputs and summarizes exactly what a retry can reuse without exposing book text.
 */
export async function writeRunManifest(root: string, job: PersistedJob): Promise<RunManifest> {
  const [drafts, edits, audits, repairs, prepared] = await Promise.all([
    readJournal<JournalRecord>(join(root, "drafts.ndjson")),
    readJournal<JournalRecord>(join(root, "edits.ndjson")),
    readJournal<JournalRecord>(join(root, "audits.ndjson")),
    readJournal<JournalRecord>(join(root, "repairs.ndjson")),
    isPrepared(root),
  ]);
  const total = job.progress.total;
  const resumable = prepared && ["paused", "failed", "needs_attention"].includes(job.status);
  const manifest: RunManifest = {
    version: MANIFEST_VERSION,
    sourceFingerprint: job.sourceFingerprint ?? null,
    preparationVersion: PREPARATION_VERSION,
    createdAt: job.createdAt,
    updatedAt: new Date().toISOString(),
    status: job.status,
    stage: job.stage,
    recovery: {
      eligible: resumable,
      reason: resumable
        ? "Prepared source and compatible checkpoints will be reused where valid."
        : prepared
          ? "The run is not in a resumable state."
          : "The source has not been prepared yet.",
    },
    units: {
      translation: unitState(countCompleted(drafts), total),
      editing: unitState(countCompleted(edits), total),
      audit: unitState(countCompleted(audits), job.qualityMode === "high" ? total : 0),
      // Repair only visits batches the audit flagged, so the whole book is not its denominator.
      repair: unitState(countCompleted(repairs), countCompleted(repairs)),
    },
  };
  await atomicJson(join(root, "run-manifest.json"), manifest);
  return manifest;
}
