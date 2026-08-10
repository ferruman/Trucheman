import { MAX_BATCH_SEGMENTS } from "../epub/batcher.js";
import type {
  LanguageModelProvider,
  ProviderInputSegment,
  ProviderLanguage,
  ProviderProfile,
  ProviderRequest,
  ProviderResponse,
} from "../providers/provider.js";
import { ProviderError } from "../providers/provider.js";
import { qualityWarnings, validateProviderResponse } from "../providers/response-validator.js";
import { abortableDelay, retryDecision } from "../providers/retry-policy.js";

export async function processBatch(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  mode: ProviderRequest["mode"],
  segments: ProviderInputSegment[],
  languages: { sourceLanguage: ProviderLanguage; targetLanguage: ProviderLanguage },
  instructions = "",
  glossary: unknown[] = [],
  maxRetries = 3,
  signal?: AbortSignal,
) {
  let attempts = 0;

  const processChunk = async (chunk: ProviderInputSegment[]): Promise<ProviderResponse> => {
    for (let attempt = 0; ; attempt++) {
      attempts++;
      try {
        const result = await provider.complete(
          {
            profile,
            mode,
            segments: chunk,
            ...languages,
            instructions,
            glossary,
            promptVersion: profile.promptVersion,
          },
          signal,
        );
        return validateProviderResponse(result, chunk);
      } catch (error) {
        if (error instanceof ProviderError && error.partialResponse && chunk.length > 1) {
          const partial = error.partialResponse;
          const exactShape =
            partial.segments.length === chunk.length &&
            partial.segments.every((segment, index) => segment.id === chunk[index].id);
          const emptyIndexes = exactShape
            ? partial.segments.flatMap((segment, index) =>
                typeof segment.text === "string" && !segment.text.trim() ? [index] : [],
              )
            : [];
          if (emptyIndexes.length && emptyIndexes.length < chunk.length) {
            const recovered = await processChunk(emptyIndexes.map((index) => chunk[index]));
            const recoveredById = new Map(
              recovered.segments.map((segment) => [segment.id, segment.text]),
            );
            return validateProviderResponse(
              {
                segments: partial.segments.map((segment) => ({
                  ...segment,
                  text: recoveredById.get(segment.id) ?? segment.text,
                })),
                finishReason: "stop",
              },
              chunk,
            );
          }
        }
        const kind = (error as { kind?: string }).kind ?? "invalid_response";
        const decision = retryDecision(
          { kind, status: (error as { status?: number }).status },
          attempt,
          maxRetries,
        );
        if (!decision.retry) throw error;
        await abortableDelay(decision.delayMs, signal);
      }
    }
  };

  const responses: ProviderResponse[] = [];
  for (let offset = 0; offset < segments.length; offset += MAX_BATCH_SEGMENTS) {
    responses.push(await processChunk(segments.slice(offset, offset + MAX_BATCH_SEGMENTS)));
  }

  const result: ProviderResponse = {
    segments: responses.flatMap((response) => response.segments),
    finishReason: "stop",
  };
  const valid = validateProviderResponse(result, segments);
  return { result: valid, warnings: qualityWarnings(segments, valid.segments), attempts };
}
