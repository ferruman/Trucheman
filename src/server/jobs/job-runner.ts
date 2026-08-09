import { createHash } from "node:crypto";
import { appendJournal, readJournal } from "../storage/ndjson-journal.js";
import type {
  LanguageModelProvider,
  ProviderInputSegment,
  ProviderLanguage,
  ProviderProfile,
  ProviderSegment,
} from "../providers/provider.js";
import { PROMPT_INPUT_VERSION, PROMPT_VERSION } from "../providers/prompts.js";
import type { Batch } from "../epub/batcher.js";
import { processBatch } from "./translation-service.js";
import { buildEditingSegments, editBatch } from "./editing-service.js";
export type RunnerOptions = {
  root: string;
  translationProfile: ProviderProfile;
  editingProfile: ProviderProfile;
  sourceLanguage: ProviderLanguage;
  targetLanguage: ProviderLanguage;
  instructions?: string;
  glossary?: unknown[];
  onProgress?: (stage: "translation" | "editing", batch: Batch) => Promise<void> | void;
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
  mode: "translation" | "editing",
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
        promptVersion: profile.promptVersion ?? PROMPT_VERSION,
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
  const drafts = new Map<string, ProviderSegment[]>(),
    edits = new Map<string, ProviderSegment[]>();
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
    if (savedEdit) edits.set(batch.id, savedEdit.segments);
    else {
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
      edits.set(batch.id, edited.result.segments);
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
  }
  return { drafts, edits };
}
