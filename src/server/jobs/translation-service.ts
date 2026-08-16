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

/**
 * For audit responses `issues` is the contract and `text` is only a journal-friendly
 * serialization, so derive it here rather than making every provider remember to.
 */
function canonicalAuditText(
  response: ProviderResponse,
  mode: ProviderRequest["mode"],
): ProviderResponse {
  if (mode !== "audit") return response;
  return {
    ...response,
    segments: response.segments.map((segment) =>
      segment && !segment.text && segment.issues
        ? { ...segment, text: JSON.stringify({ issues: segment.issues }) }
        : segment,
    ),
  };
}

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
        return validateProviderResponse(canonicalAuditText(result, mode), chunk);
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
        // The provider builds this message specifically to tell "the answer was cut off" apart
        // from "the model wrote something that is not JSON", and every caller above used to
        // throw it away — a run could spend most of its completion tokens on rejected answers
        // and say nothing anywhere about why. Retries are invisible in the journals by design;
        // this is the one line that makes a bad batch diagnosable.
        console.warn(
          `[${mode}] attempt ${attempt + 1} rejected (${kind}, ${chunk.length} segment(s), ${
            chunk[0]?.id ?? "unknown"
          }): ${error instanceof Error ? error.message : String(error)}`,
        );
        const decision = retryDecision(
          { kind, status: (error as { status?: number }).status },
          attempt,
          maxRetries,
        );
        if (!decision.retry) {
          // A batch whose answer the model cannot keep valid does not get better by being
          // asked a fourth time — every retry sends the same prompt. Halving it does change
          // the question, and the defect almost always travels with one batch rather than
          // with the book, so this turns a run-ending error into a slower batch. Halves
          // recurse down to a single segment, which still throws.
          if (kind === "invalid_response" && chunk.length > 1) {
            const middle = Math.ceil(chunk.length / 2);
            // Sequential: splitting must not double the concurrency the pool was sized for.
            const head = await processChunk(chunk.slice(0, middle));
            const tail = await processChunk(chunk.slice(middle));
            return validateProviderResponse(
              { segments: [...head.segments, ...tail.segments], finishReason: "stop" },
              chunk,
            );
          }
          throw error;
        }
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
