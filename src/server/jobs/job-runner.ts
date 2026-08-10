import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { appendJournal, readJournal } from "../storage/ndjson-journal.js";
import type {
  LanguageModelProvider,
  ProviderInputSegment,
  ProviderLanguage,
  ProviderProfile,
  ProviderRequest,
  ProviderSegment,
} from "../providers/provider.js";
import {
  PROMPT_INPUT_VERSION,
  promptVersionForMode,
  relevantGlossary,
} from "../providers/prompts.js";
import type { Batch } from "../epub/batcher.js";
import { processBatch } from "./translation-service.js";
import { buildEditingSegments, editBatch } from "./editing-service.js";
import {
  applySelectiveRepairs,
  auditBatch,
  buildQualityAuditSegments,
  buildRepairSegments,
  parseQualityFindings,
  repairBatch,
  type QualityFinding,
  type RepairRejection,
} from "./quality-service.js";

export type RunnerStage = "translation" | "editing" | "audit" | "repair";
export type RunnerOptions = {
  root: string;
  translationProfile: ProviderProfile;
  editingProfile: ProviderProfile;
  criticProfile?: ProviderProfile;
  sourceLanguage: ProviderLanguage;
  targetLanguage: ProviderLanguage;
  instructions?: string;
  glossary?: unknown[];
  qualityMode?: "standard" | "high";
  /**
   * Re-audit only the logical blocks a repair actually changed, reverting any that still
   * carry a high-severity issue. Off by default: it is a second paid critic pass.
   */
  postRepairAudit?: boolean;
  /**
   * Batches in flight at once. Batches are independent — no context crosses them and the
   * consistency pass runs after all of them — so this is pure wall-clock, bounded by the
   * provider's rate limit rather than by anything here. Defaults to one: callers that want
   * the speed opt in, so a plain run stays in book order.
   */
  concurrency?: number;
  recoverCompatibleCheckpoints?: boolean;
  onStage?: (stage: RunnerStage, batch: Batch) => Promise<void> | void;
  onProgress?: (stage: RunnerStage, batch: Batch, cached: boolean) => Promise<void> | void;
  signal?: AbortSignal;
};
type Checkpoint = { batchId: string; segments: ProviderSegment[]; checkpointKey?: string };

function checkpointMap(records: Checkpoint[]) {
  const result = new Map<string, Checkpoint>();
  for (const record of records)
    if (record && typeof record.checkpointKey === "string" && Array.isArray(record.segments))
      result.set(record.checkpointKey, record);
  return result;
}

function checkpointBatchMap(records: Checkpoint[]) {
  const result = new Map<string, Checkpoint>();
  for (const record of records) {
    if (record && typeof record.batchId === "string" && Array.isArray(record.segments)) {
      result.set(record.batchId, record);
    }
  }
  return result;
}

function compatibleCheckpoint(
  record: Checkpoint | undefined,
  expected: ProviderInputSegment[],
): Checkpoint | undefined {
  if (
    record?.segments.length === expected.length &&
    record.segments.every((segment, index) => segment.id === expected[index].id)
  ) {
    return record;
  }
  return undefined;
}

function checkpointKey(
  mode: ProviderRequest["mode"],
  profile: ProviderProfile,
  segments: ProviderInputSegment[],
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  instructions: string | undefined,
  glossary: unknown[] | undefined,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        promptVersion: promptVersionForMode(mode, profile.promptVersion),
        promptInputVersion: PROMPT_INPUT_VERSION,
        mode,
        profile: {
          name: profile.name,
          endpoint: profile.endpoint,
          model: profile.model,
          temperature: profile.temperature,
          thinking: profile.thinking,
        },
        sourceLanguage,
        targetLanguage,
        segments,
        instructions: instructions ?? "",
        // The key must describe the prompt that was sent, so an entry this batch never
        // sees cannot invalidate its checkpoint.
        glossary: relevantGlossary(glossary, segments),
      }),
    )
    .digest("hex");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Job paused");
}

/**
 * Second critic pass over the blocks a repair changed. A block that still carries a
 * high-severity issue falls back to its pre-repair edited text, which the first audit
 * already judged acceptable enough to keep.
 */
async function verifyRepairedBlocks(
  provider: LanguageModelProvider,
  criticProfile: ProviderProfile,
  options: RunnerOptions,
  request: ProviderSegment[],
  draft: ProviderSegment[],
  before: ProviderSegment[],
  after: ProviderSegment[],
): Promise<ProviderSegment[]> {
  const beforeById = new Map(before.map((segment) => [segment.id, segment.text]));
  const changed = new Set(
    after.filter((segment) => beforeById.get(segment.id) !== segment.text).map((s) => s.id),
  );
  if (!changed.size) return after;
  const verified = await auditBatch(
    provider,
    criticProfile,
    buildQualityAuditSegments(
      request.filter((segment) => changed.has(segment.id)),
      draft.filter((segment) => changed.has(segment.id)),
      after.filter((segment) => changed.has(segment.id)),
    ),
    { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage },
    options.instructions,
    options.glossary,
    options.signal,
  );
  const stillBroken = new Set(
    verified.findings
      .filter((finding) => finding.issues.some((issue) => issue.severity === "high"))
      .map((finding) => finding.id),
  );
  return after.map((segment) =>
    stillBroken.has(segment.id)
      ? { ...segment, text: beforeById.get(segment.id) ?? segment.text }
      : segment,
  );
}

export async function runTwoPass(
  batches: Batch[],
  provider: LanguageModelProvider,
  options: RunnerOptions,
) {
  const criticProfile = options.criticProfile ?? options.editingProfile;
  const draftJournal = await readJournal<Checkpoint>(`${options.root}/drafts.ndjson`);
  const editJournal = await readJournal<Checkpoint>(`${options.root}/edits.ndjson`);
  const auditJournal = await readJournal<Checkpoint>(`${options.root}/audits.ndjson`);
  const repairJournal = await readJournal<Checkpoint>(`${options.root}/repairs.ndjson`);
  const draftRecords = checkpointMap(draftJournal);
  const editRecords = checkpointMap(editJournal);
  const auditRecords = checkpointMap(auditJournal);
  const repairRecords = checkpointMap(repairJournal);
  const draftsByBatch = checkpointBatchMap(draftJournal);
  const editsByBatch = checkpointBatchMap(editJournal);
  const auditsByBatch = checkpointBatchMap(auditJournal);
  const repairsByBatch = checkpointBatchMap(repairJournal);
  const drafts = new Map<string, ProviderSegment[]>(),
    edits = new Map<string, ProviderSegment[]>();
  // Both are indexed by batch position: a parallel run finishes out of order, and the quality
  // report has to read in book order regardless of who finished first.
  const qualityFindings: Array<{ batchId: string; findings: QualityFinding[] }> = [];
  const rejectedRepairsByBatch: Array<Array<RepairRejection & { batchId: string }>> = [];
  const cachedCheckpoints = { translation: 0, editing: 0, audit: 0, repair: 0 };
  const runBatch = async (batch: Batch, index: number) => {
    throwIfAborted(options.signal);
    const request = batch.segments.map((s) => ({ id: s.id, text: s.text }));
    const expectedDraftKey = checkpointKey(
      "translation",
      options.translationProfile,
      request,
      options.sourceLanguage,
      options.targetLanguage,
      options.instructions,
      options.glossary,
    );
    const savedDraft =
      draftRecords.get(expectedDraftKey) ??
      (options.recoverCompatibleCheckpoints
        ? compatibleCheckpoint(draftsByBatch.get(batch.id), request)
        : undefined);
    let draft = savedDraft?.segments;
    if (!draft) {
      await options.onStage?.("translation", batch);
      const translated = await processBatch(
        provider,
        options.translationProfile,
        "translation",
        request,
        { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage },
        options.instructions,
        options.glossary,
        3,
        options.signal,
      );
      draft = translated.result.segments;
      await appendJournal(`${options.root}/drafts.ndjson`, {
        batchId: batch.id,
        segments: draft,
        checkpointKey: expectedDraftKey,
        attempts: translated.attempts,
        warnings: translated.warnings,
        profile: options.translationProfile.name,
      });
    }
    drafts.set(batch.id, draft);
    if (savedDraft) cachedCheckpoints.translation++;
    await options.onProgress?.("translation", batch, Boolean(savedDraft));
    throwIfAborted(options.signal);
    const editingSegments = buildEditingSegments(request, draft);
    const expectedEditKey = checkpointKey(
      "editing",
      options.editingProfile,
      editingSegments,
      options.sourceLanguage,
      options.targetLanguage,
      options.instructions,
      options.glossary,
    );
    const savedEdit =
      editRecords.get(expectedEditKey) ??
      (options.recoverCompatibleCheckpoints
        ? compatibleCheckpoint(editsByBatch.get(batch.id), editingSegments)
        : undefined);
    let editedSegments = savedEdit?.segments;
    if (!editedSegments) {
      await options.onStage?.("editing", batch);
      const edited = await editBatch(
        provider,
        options.editingProfile,
        request,
        draft,
        { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage },
        options.instructions,
        options.glossary,
        options.signal,
      );
      editedSegments = edited.result.segments;
      await appendJournal(`${options.root}/edits.ndjson`, {
        batchId: batch.id,
        segments: edited.result.segments,
        checkpointKey: expectedEditKey,
        attempts: edited.attempts,
        warnings: edited.warnings,
        profile: options.editingProfile.name,
      });
    }
    if (savedEdit) cachedCheckpoints.editing++;
    await options.onProgress?.("editing", batch, Boolean(savedEdit));
    if (options.qualityMode === "high") {
      throwIfAborted(options.signal);
      const auditSegments = buildQualityAuditSegments(request, draft, editedSegments);
      const expectedAuditKey = checkpointKey(
        "audit",
        criticProfile,
        auditSegments,
        options.sourceLanguage,
        options.targetLanguage,
        options.instructions,
        options.glossary,
      );
      const savedAudit =
        auditRecords.get(expectedAuditKey) ??
        (options.recoverCompatibleCheckpoints
          ? compatibleCheckpoint(auditsByBatch.get(batch.id), auditSegments)
          : undefined);
      let findings: QualityFinding[];
      if (savedAudit) {
        findings = parseQualityFindings(auditSegments, savedAudit.segments);
      } else {
        await options.onStage?.("audit", batch);
        const audited = await auditBatch(
          provider,
          criticProfile,
          auditSegments,
          { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage },
          options.instructions,
          options.glossary,
          options.signal,
        );
        findings = audited.findings;
        await appendJournal(`${options.root}/audits.ndjson`, {
          batchId: batch.id,
          segments: audited.result.segments,
          checkpointKey: expectedAuditKey,
          attempts: audited.attempts,
          warnings: audited.warnings,
          profile: criticProfile.name,
        });
      }
      qualityFindings[index] = { batchId: batch.id, findings };
      if (savedAudit) cachedCheckpoints.audit++;
      await options.onProgress?.("audit", batch, Boolean(savedAudit));
      const repairSegments = buildRepairSegments(auditSegments, findings);
      if (repairSegments.length) {
        throwIfAborted(options.signal);
        const expectedRepairKey = checkpointKey(
          "repair",
          options.editingProfile,
          repairSegments,
          options.sourceLanguage,
          options.targetLanguage,
          options.instructions,
          options.glossary,
        );
        const savedRepair =
          repairRecords.get(expectedRepairKey) ??
          (options.recoverCompatibleCheckpoints
            ? compatibleCheckpoint(repairsByBatch.get(batch.id), repairSegments)
            : undefined);
        let repairs = savedRepair?.segments;
        if (!repairs) {
          await options.onStage?.("repair", batch);
          const repaired = await repairBatch(
            provider,
            options.editingProfile,
            repairSegments,
            { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage },
            options.instructions,
            options.glossary,
            options.signal,
          );
          repairs = repaired.result.segments;
          await appendJournal(`${options.root}/repairs.ndjson`, {
            batchId: batch.id,
            segments: repairs,
            checkpointKey: expectedRepairKey,
            attempts: repaired.attempts,
            warnings: repaired.warnings,
            profile: options.editingProfile.name,
          });
        }
        const beforeRepair = editedSegments;
        const reviewed = applySelectiveRepairs(editedSegments, repairs);
        editedSegments = reviewed.segments;
        rejectedRepairsByBatch[index] = reviewed.rejected.map((rejection) => ({
          batchId: batch.id,
          ...rejection,
        }));
        if (savedRepair) cachedCheckpoints.repair++;
        await options.onProgress?.("repair", batch, Boolean(savedRepair));
        if (options.postRepairAudit) {
          editedSegments = await verifyRepairedBlocks(
            provider,
            criticProfile,
            options,
            request,
            draft,
            beforeRepair,
            editedSegments,
          );
        }
      }
    }
    edits.set(batch.id, editedSegments);
  };
  const queue = batches.entries();
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.trunc(options.concurrency ?? 1)) }, async () => {
      // A shared iterator is the work queue: whoever finishes a batch takes the next one.
      for (const [index, batch] of queue) {
        // One failed batch fails the run, so the other workers must stop claiming new ones
        // instead of paying for the rest of the book.
        if (failed) return;
        try {
          await runBatch(batch, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const rejectedRepairs = rejectedRepairsByBatch.flat();
  if (options.qualityMode === "high") {
    const allFindings = qualityFindings.flatMap(({ batchId, findings }) =>
      findings.map((finding) => ({ batchId, ...finding })),
    );
    await writeFile(
      `${options.root}/quality-report.json`,
      JSON.stringify(
        {
          version: 2,
          auditedSegments: allFindings.length,
          flaggedSegments: allFindings.filter((finding) => finding.issues.length).length,
          repairedSegments:
            allFindings.filter((finding) => finding.issues.length).length - rejectedRepairs.length,
          auditErrorSegments: allFindings.filter((finding) => finding.auditError).length,
          auditErrorsByKind: {
            malformed_json: allFindings.filter((f) => f.auditError === "malformed_json").length,
            invalid_issues: allFindings.filter((f) => f.auditError === "invalid_issues").length,
          },
          rejectedIssues: allFindings.reduce((total, finding) => total + finding.rejectedIssues, 0),
          rejectedRepairs,
          cachedCheckpoints,
          findings: allFindings.filter((finding) => finding.issues.length || finding.auditError),
        },
        null,
        2,
      ),
    );
  }
  return {
    drafts,
    edits,
    cachedCheckpoints,
    rejectedRepairs,
    qualityAuditErrors: qualityFindings.reduce(
      (total, batch) =>
        total + batch.findings.filter((finding) => finding.auditError !== undefined).length,
      0,
    ),
  };
}
