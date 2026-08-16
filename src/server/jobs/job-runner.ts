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
import { scanSegments, type SegmentDefect, type SegmentDefectKind } from "./segment-scan.js";

const SEGMENT_DEFECT_KINDS: SegmentDefectKind[] = [
  "empty",
  "untranslated",
  "length_ratio",
  "missing_numbers",
  "source_residue",
  "source_interference",
];
/** The report is a diagnostic, not a journal; a broken run must not write a 100k-entry file. */
const MAX_REPORTED_DEFECTS = 500;

export function buildSegmentScanReport(scanDefects: SegmentDefect[]) {
  const actionable = scanDefects.filter((defect) => defect.kind !== "source_residue");
  return {
    defectSegments: new Set(scanDefects.map((defect) => defect.id)).size,
    actionableDefectSegments: new Set(actionable.map((defect) => defect.id)).size,
    advisoryDefectSegments: new Set(
      scanDefects.filter((defect) => defect.kind === "source_residue").map((defect) => defect.id),
    ).size,
    defectsByKind: Object.fromEntries(
      SEGMENT_DEFECT_KINDS.map((kind) => [
        kind,
        scanDefects.filter((defect) => defect.kind === kind).length,
      ]),
    ),
    defects: scanDefects.slice(0, MAX_REPORTED_DEFECTS),
  };
}

export type RunnerStage = "translation" | "editing" | "audit" | "repair";
export type RunnerOptions = {
  root: string;
  translationProfile: ProviderProfile;
  editingProfile: ProviderProfile;
  criticProfile?: ProviderProfile;
  /** Defaults to the editing profile, which is where repair lived before it had its own. */
  repairProfile?: ProviderProfile;
  sourceLanguage: ProviderLanguage;
  targetLanguage: ProviderLanguage;
  instructions?: string;
  /** Document id → the chapter card prompt block for every batch of that document. */
  chapterCards?: Map<string, string>;
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
  /** Every stage of this batch is done. Concurrent callers need it to know what is still open. */
  onBatchDone?: (batch: Batch) => Promise<void> | void;
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
 * A block that came back byte-identical to its source was never translated at all, and the
 * critic is the wrong instrument to notice: it is asked to judge a translation, so it reads
 * the untouched English as the translation and finds it excellent. The scan sees it for
 * free, so it joins the critic's findings instead of only reaching the report.
 *
 * Three high-confidence shapes are routed here. `source_residue` is not one of them: it fires on «Project
 * Gutenberg», which the licence requires to stay English, on a kept German line and on a band
 * name. Most `length_ratio` findings and all `missing_numbers` findings remain advisory; only
 * a long block below 55% is treated as truncation. `source_interference` is the subset the scan
 * can tell apart with certainty: a source word with target-language words on both sides.
 */
function untranslatedFindings(
  request: ProviderSegment[],
  edited: ProviderSegment[],
  targetTag: string | undefined,
): QualityFinding[] {
  const editedById = new Map(edited.map((segment) => [segment.id, segment.text]));
  const sourceById = new Map(request.map((segment) => [segment.id, segment.text]));
  const findings = scanSegments(request, edited, targetTag)
    .filter((defect) => {
      if (defect.kind === "untranslated" || defect.kind === "source_interference") return true;
      if (defect.kind !== "length_ratio") return false;
      const source = sourceById.get(defect.id) ?? "";
      const translation = editedById.get(defect.id) ?? "";
      // A long Russian block below 55% of its English source is not ordinary compression.
      // The production case had silently dropped three of five sentences at 48%.
      return source.length >= 200 && translation.length / source.length < 0.55;
    })
    .map((defect) => ({
      id: defect.id,
      rejectedIssues: 0,
      issues:
        defect.kind === "untranslated"
          ? [
              {
                span: (editedById.get(defect.id) ?? "").slice(0, 2000),
                type: "source_language_interference" as const,
                severity: "high" as const,
                reason: "The block is identical to the original: it was never translated.",
              },
            ]
          : defect.kind === "length_ratio"
            ? [
                {
                  span: (editedById.get(defect.id) ?? "").slice(0, 2000),
                  type: "semantic_error" as const,
                  severity: "high" as const,
                  reason:
                    "The translated block is less than 55% of a long source block; restore the omitted source content.",
                },
              ]
            : (defect.spans ?? []).map((span) => ({
                span,
                type: "source_language_interference" as const,
                severity: "high" as const,
                reason: `"${span}" is a source-language word left inside a translated sentence.`,
              })),
    }))
    .filter((finding) => finding.issues.length);
  const malformedQuotedEndings = edited.flatMap((segment) => {
    const spans = [...segment.text.matchAll(/«[^»\n]{1,120}»[а-яё]{1,3}(?!\p{L})/giu)].map(
      (match) => match[0],
    );
    return spans.length
      ? [
          {
            id: segment.id,
            rejectedIssues: 0,
            issues: spans.map((span) => ({
              span,
              type: "unnatural_language" as const,
              severity: "high" as const,
              reason:
                "A Russian case ending was placed outside the closing guillemet; inflect the title inside the quotation or rephrase with a generic noun.",
            })),
          },
        ]
      : [];
  });
  return mergeFindings(findings, malformedQuotedEndings);
}

/** Critic findings plus the scan's, merged per block so one id never asks for two repairs. */
function mergeFindings(audited: QualityFinding[], scanned: QualityFinding[]): QualityFinding[] {
  if (!scanned.length) return audited;
  const byId = new Map(audited.map((finding) => [finding.id, finding]));
  for (const finding of scanned) {
    const existing = byId.get(finding.id);
    byId.set(
      finding.id,
      existing ? { ...existing, issues: [...existing.issues, ...finding.issues] } : finding,
    );
  }
  return [...byId.values()];
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
  instructions: string | undefined,
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
    instructions,
    options.glossary,
    options.signal,
  );
  const stillBroken = new Set(
    verified.findings
      .filter((finding) => finding.issues.some((issue) => issue.severity === "high"))
      .map((finding) => finding.id),
  );
  // The critic is not asked twice about what the scan can see for free, and a repair that
  // leaves a source word inside the sentence it rewrote is strictly worse than the text it
  // replaced: fixing «он formally поклонился» is what put «в grand жесте» two blocks away.
  for (const defect of scanSegments(
    request.filter((segment) => changed.has(segment.id)),
    after.filter((segment) => changed.has(segment.id)),
    options.targetLanguage.tag,
  )) {
    if (defect.kind === "source_interference" || defect.kind === "untranslated")
      stillBroken.add(defect.id);
  }
  return after.map((segment) =>
    stillBroken.has(segment.id)
      ? { ...segment, text: beforeById.get(segment.id) ?? segment.text }
      : segment,
  );
}

export async function runQualityPipeline(
  batches: Batch[],
  provider: LanguageModelProvider,
  options: RunnerOptions,
) {
  const criticProfile = options.criticProfile ?? options.editingProfile;
  const repairProfile = options.repairProfile ?? options.editingProfile;
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
  /** Sent to repair and came back unchanged: flagged, paid for, and still defective. */
  const unrepairedByBatch: Array<Array<{ batchId: string; id: string }>> = [];
  /** Repairs the provider could not answer at all; the edited text stands. */
  const failedRepairs: Array<{ batchId: string; reason: string }> = [];
  const scanDefectsByBatch: Array<Array<SegmentDefect & { batchId: string }>> = [];
  const cachedCheckpoints = { translation: 0, editing: 0, audit: 0, repair: 0 };
  const runBatch = async (batch: Batch, index: number) => {
    throwIfAborted(options.signal);
    const request = batch.segments.map((s) => ({ id: s.id, text: s.text }));
    // Every stage of this batch, and every checkpoint key, sees the same instructions: the
    // user's, plus the card for the chapter this batch belongs to.
    const instructions =
      [options.instructions, options.chapterCards?.get(batch.documentId)]
        .filter((part) => part?.trim())
        .join("\n\n") || undefined;
    const expectedDraftKey = checkpointKey(
      "translation",
      options.translationProfile,
      request,
      options.sourceLanguage,
      options.targetLanguage,
      instructions,
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
        instructions,
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
      instructions,
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
        instructions,
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
        instructions,
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
          instructions,
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
      findings = mergeFindings(
        findings,
        untranslatedFindings(request, editedSegments, options.targetLanguage.tag),
      );
      qualityFindings[index] = { batchId: batch.id, findings };
      if (savedAudit) cachedCheckpoints.audit++;
      await options.onProgress?.("audit", batch, Boolean(savedAudit));
      const repairSegments = buildRepairSegments(auditSegments, findings);
      if (repairSegments.length) {
        const repairedIds = new Set(repairSegments.map((segment) => segment.id));
        throwIfAborted(options.signal);
        const expectedRepairKey = checkpointKey(
          "repair",
          repairProfile,
          repairSegments,
          options.sourceLanguage,
          options.targetLanguage,
          instructions,
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
          try {
            const repaired = await repairBatch(
              provider,
              repairProfile,
              repairSegments,
              { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage },
              instructions,
              options.glossary,
              options.signal,
            );
            repairs = repaired.result.segments;
            let attempts = repaired.attempts;
            const warnings = [...repaired.warnings];
            const repairById = new Map(repairs.map((segment) => [segment.id, segment]));
            const unchangedInputs = repairSegments.filter(
              (segment) => repairById.get(segment.id)?.text === segment.editedTranslation,
            );
            if (unchangedInputs.length) {
              // One focused retry is cheaper than shipping a known defect after paying for the
              // critic and first repair. It sees only the blocks the first call ignored.
              const retried = await repairBatch(
                provider,
                repairProfile,
                unchangedInputs,
                { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage },
                [
                  instructions,
                  "The previous repair returned these blocks unchanged. Resolve every listed issue with a concrete edit unless the issue is directly contradicted by the source or exact span.",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                options.glossary,
                options.signal,
              );
              attempts += retried.attempts;
              warnings.push(...retried.warnings);
              for (const segment of retried.result.segments) repairById.set(segment.id, segment);
              repairs = repairSegments.flatMap((segment) => {
                const replacement = repairById.get(segment.id);
                return replacement ? [replacement] : [];
              });
            }
            await appendJournal(`${options.root}/repairs.ndjson`, {
              batchId: batch.id,
              segments: repairs,
              checkpointKey: expectedRepairKey,
              attempts,
              warnings,
              profile: repairProfile.name,
            });
          } catch (error) {
            // Pausing must still pause; anything else is one batch's polish, not the book.
            if (options.signal?.aborted) throw error;
            // A repair the provider cannot answer used to end the run: a single segment has no
            // half to fall back on, so four malformed answers to one block threw away 420 of a
            // volume's 503 batches. The edited text this repair was going to improve is already
            // known to be acceptable — `reviewRepair` keeps it for every other rejection — so
            // the batch keeps it here too and the book finishes.
            failedRepairs.push({
              batchId: batch.id,
              reason: error instanceof Error ? error.message : "unknown error",
            });
            repairs = [];
          }
        }
        const beforeRepair = editedSegments;
        const reviewed = applySelectiveRepairs(editedSegments, repairs, repairSegments);
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
            instructions,
          );
        }
        // A block the model handed back word for word was not repaired, and neither was one
        // the post-repair audit reverted. Counting those as repaired reported «Рег crouched
        // перед Шэдоу» — flagged, sent, returned unchanged — as one of 57 fixed blocks.
        const beforeById = new Map(beforeRepair.map((segment) => [segment.id, segment.text]));
        const rejectedIds = new Set(reviewed.rejected.map((rejection) => rejection.id));
        unrepairedByBatch[index] = editedSegments
          .filter(
            (segment) =>
              repairedIds.has(segment.id) &&
              !rejectedIds.has(segment.id) &&
              segment.text === beforeById.get(segment.id),
          )
          .map((segment) => ({ batchId: batch.id, id: segment.id }));
      }
    }
    edits.set(batch.id, editedSegments);
    scanDefectsByBatch[index] = scanSegments(
      request,
      editedSegments,
      options.targetLanguage.tag,
    ).map((defect) => ({
      batchId: batch.id,
      ...defect,
    }));
    await options.onBatchDone?.(batch);
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
  const unrepaired = unrepairedByBatch.flat();
  const scanDefects = scanDefectsByBatch.flat();
  {
    const allFindings = qualityFindings.flatMap(({ batchId, findings }) =>
      findings.map((finding) => ({ batchId, ...finding })),
    );
    const flagged = allFindings.filter((finding) => finding.issues.length);
    const repairKey = (value: { batchId: string; id: string }) => `${value.batchId}\0${value.id}`;
    const unresolvedKeys = new Set([
      ...rejectedRepairs.map(repairKey),
      ...unrepaired.map(repairKey),
    ]);
    const unresolvedFindings = flagged.filter((finding) => unresolvedKeys.has(repairKey(finding)));
    // Written in both quality modes: the deterministic scan is the only per-segment quality
    // signal a standard run produces, and it costs nothing.
    await writeFile(
      `${options.root}/quality-report.json`,
      JSON.stringify(
        {
          version: 6,
          scan: buildSegmentScanReport(scanDefects),
          auditedSegments: allFindings.length,
          /** Initial critic findings, before repair. Kept for historical comparison. */
          flaggedSegments: flagged.length,
          repairedSegments: flagged.length - unresolvedKeys.size,
          remainingFlaggedSegments: unresolvedKeys.size,
          repairOutcomes: {
            changed: flagged.length - unresolvedKeys.size,
            unchanged: unrepaired.length,
            rejected: rejectedRepairs.length,
            /** Batches whose repair the provider never answered; their edit stands. */
            failed: failedRepairs.length,
          },
          failedRepairs,
          auditErrorSegments: allFindings.filter((finding) => finding.auditError).length,
          auditErrorsByKind: {
            malformed_json: allFindings.filter((f) => f.auditError === "malformed_json").length,
            invalid_issues: allFindings.filter((f) => f.auditError === "invalid_issues").length,
          },
          rejectedIssues: allFindings.reduce((total, finding) => total + finding.rejectedIssues, 0),
          rejectedRepairs,
          unrepairedSegments: unrepaired,
          unresolvedFindings,
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
    failedRepairs,
    rejectedRepairs,
    unrepairedSegments: unrepaired,
    scanDefects,
    qualityAuditErrors: qualityFindings.reduce(
      (total, batch) =>
        total + batch.findings.filter((finding) => finding.auditError !== undefined).length,
      0,
    ),
  };
}
