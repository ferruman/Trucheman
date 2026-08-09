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
import { PROMPT_INPUT_VERSION, promptVersionForMode } from "../providers/prompts.js";
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
} from "./quality-service.js";

export type RunnerStage = "translation" | "editing" | "audit" | "repair";
export type RunnerOptions = {
  root: string;
  translationProfile: ProviderProfile;
  editingProfile: ProviderProfile;
  sourceLanguage: ProviderLanguage;
  targetLanguage: ProviderLanguage;
  instructions?: string;
  glossary?: unknown[];
  qualityMode?: "standard" | "high";
  onProgress?: (stage: RunnerStage, batch: Batch) => Promise<void> | void;
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
        glossary: glossary ?? [],
      }),
    )
    .digest("hex");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Job paused");
}

export async function runTwoPass(
  batches: Batch[],
  provider: LanguageModelProvider,
  options: RunnerOptions,
) {
  const draftRecords = checkpointMap(
    await readJournal<Checkpoint>(`${options.root}/drafts.ndjson`),
  );
  const editRecords = checkpointMap(await readJournal<Checkpoint>(`${options.root}/edits.ndjson`));
  const auditRecords = checkpointMap(
    await readJournal<Checkpoint>(`${options.root}/audits.ndjson`),
  );
  const repairRecords = checkpointMap(
    await readJournal<Checkpoint>(`${options.root}/repairs.ndjson`),
  );
  const drafts = new Map<string, ProviderSegment[]>(),
    edits = new Map<string, ProviderSegment[]>();
  const qualityFindings: Array<{ batchId: string; findings: QualityFinding[] }> = [];
  for (const batch of batches) {
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
    const savedDraft = draftRecords.get(expectedDraftKey);
    let draft = savedDraft?.segments;
    if (!draft) {
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
    await options.onProgress?.("translation", batch);
    throwIfAborted(options.signal);
    const expectedEditKey = checkpointKey(
      "editing",
      options.editingProfile,
      buildEditingSegments(request, draft),
      options.sourceLanguage,
      options.targetLanguage,
      options.instructions,
      options.glossary,
    );
    const savedEdit = editRecords.get(expectedEditKey);
    let editedSegments = savedEdit?.segments;
    if (!editedSegments) {
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
    await options.onProgress?.("editing", batch);
    if (options.qualityMode === "high") {
      throwIfAborted(options.signal);
      const auditSegments = buildQualityAuditSegments(request, draft, editedSegments);
      const expectedAuditKey = checkpointKey(
        "audit",
        options.editingProfile,
        auditSegments,
        options.sourceLanguage,
        options.targetLanguage,
        options.instructions,
        options.glossary,
      );
      const savedAudit = auditRecords.get(expectedAuditKey);
      let findings: QualityFinding[];
      if (savedAudit) {
        findings = parseQualityFindings(auditSegments, savedAudit.segments);
      } else {
        const audited = await auditBatch(
          provider,
          options.editingProfile,
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
          profile: options.editingProfile.name,
        });
      }
      qualityFindings.push({ batchId: batch.id, findings });
      await options.onProgress?.("audit", batch);
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
        const savedRepair = repairRecords.get(expectedRepairKey);
        let repairs = savedRepair?.segments;
        if (!repairs) {
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
        editedSegments = applySelectiveRepairs(editedSegments, repairs);
        await options.onProgress?.("repair", batch);
      }
    }
    edits.set(batch.id, editedSegments);
  }
  if (options.qualityMode === "high") {
    const allFindings = qualityFindings.flatMap(({ batchId, findings }) =>
      findings.map((finding) => ({ batchId, ...finding })),
    );
    await writeFile(
      `${options.root}/quality-report.json`,
      JSON.stringify(
        {
          version: 1,
          auditedSegments: allFindings.length,
          flaggedSegments: allFindings.filter((finding) => finding.issues.length).length,
          repairedSegments: allFindings.filter((finding) => finding.issues.length).length,
          rejectedIssues: allFindings.reduce((total, finding) => total + finding.rejectedIssues, 0),
          findings: allFindings.filter((finding) => finding.issues.length),
        },
        null,
        2,
      ),
    );
  }
  return { drafts, edits };
}
