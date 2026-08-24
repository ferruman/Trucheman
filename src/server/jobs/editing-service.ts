import type {
  LanguageModelProvider,
  ProviderInputSegment,
  ProviderLanguage,
  ProviderProfile,
  ProviderSegment,
} from "../providers/provider.js";
import { processBatch } from "./translation-service.js";

export function buildEditingSegments(
  original: ProviderSegment[],
  draft: ProviderSegment[],
): ProviderInputSegment[] {
  return original.map((item, index) => ({
    id: item.id,
    original: item.text,
    draft: draft[index]?.text ?? "",
  }));
}

export async function editBatch(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  original: ProviderSegment[],
  draft: ProviderSegment[],
  languages: { sourceLanguage: ProviderLanguage; targetLanguage: ProviderLanguage },
  instructions = "",
  glossary: unknown[] = [],
  signal?: AbortSignal,
) {
  return processBatch(
    provider,
    profile,
    "editing",
    buildEditingSegments(original, draft),
    languages,
    instructions,
    glossary,
    3,
    signal,
  );
}
