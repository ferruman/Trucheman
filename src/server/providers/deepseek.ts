import { buildPromptMessages } from "./prompts.js";
import {
  ProviderError,
  type LanguageModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./provider.js";
import { validateProviderResponse } from "./response-validator.js";

function withTransportIds(request: ProviderRequest): ProviderRequest {
  return {
    ...request,
    segments: request.segments.map((segment, index) => ({
      ...segment,
      id: `s${String(index + 1).padStart(4, "0")}`,
    })),
  };
}

function normalizeResponseSegments(
  value: unknown,
  mode: ProviderRequest["mode"],
): ProviderResponse["segments"] {
  if (!Array.isArray(value)) {
    return value as ProviderResponse["segments"];
  }
  const preferredFields =
    mode === "editing"
      ? [
          "edited",
          "editedText",
          "edited_text",
          "revised",
          "revisedText",
          "revised_text",
          "revision",
          "draft",
          "translation",
          "translated",
          "translatedText",
          "translated_text",
          "target",
          "targetText",
          "target_text",
          "result",
          "output",
        ]
      : [
          "translation",
          "translated",
          "translatedText",
          "translated_text",
          "target",
          "targetText",
          "target_text",
          "result",
          "output",
        ];
  const inputFields = new Set(["id", "original", "source", "sourceText", "source_text"]);

  const extractOutputText = (fieldValue: unknown, depth = 0): string | undefined => {
    if (typeof fieldValue === "string") return fieldValue;
    if (
      depth >= 3 ||
      typeof fieldValue !== "object" ||
      fieldValue === null ||
      Array.isArray(fieldValue)
    ) {
      return undefined;
    }

    const record = fieldValue as Record<string, unknown>;
    for (const field of ["text", ...preferredFields]) {
      if (!(field in record)) continue;
      const nested = extractOutputText(record[field], depth + 1);
      if (nested !== undefined) return nested;
    }

    const candidates = Object.entries(record).filter(
      ([field, nestedValue]) => !inputFields.has(field) && typeof nestedValue === "string",
    );
    return candidates.length === 1 ? (candidates[0][1] as string) : undefined;
  };

  return value.map((segment) => {
    if (typeof segment !== "object" || segment === null || !("id" in segment)) return segment;
    const record = segment as Record<string, unknown>;
    const text = extractOutputText(record);
    if (text !== undefined) return { id: segment.id, text };
    return segment;
  }) as ProviderResponse["segments"];
}

function valueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  return `object{${Object.keys(value).sort().join(",")}}`;
}

function responseFieldSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value.find((segment) => typeof segment === "object" && segment !== null);
  if (!first) return undefined;
  return Object.entries(first)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, fieldValue]) => `${field}:${valueShape(fieldValue)}`)
    .join(", ");
}

export class DeepSeekProvider implements LanguageModelProvider {
  async complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    if (!request.profile.apiKey) {
      throw new ProviderError("configuration", "Provider credential is not configured");
    }

    const transportRequest = withTransportIds(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.profile.timeoutMs ?? 60000);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const res = await fetch(request.profile.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.profile.apiKey}`,
        },
        body: JSON.stringify({
          model: request.profile.model,
          messages: buildPromptMessages(transportRequest),
          response_format: { type: "json_object" },
          temperature: request.profile.temperature,
          thinking: request.profile.thinking ? { type: request.profile.thinking } : undefined,
          stream: false,
        }),
        signal: controller.signal,
      });
      const requestId = res.headers.get("x-request-id") ?? undefined;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 400) {
          throw new ProviderError(
            "configuration",
            `Provider rejected configuration (${res.status})`,
            res.status,
          );
        }
        throw new ProviderError(
          "temporary",
          `Provider temporarily unavailable (${res.status})`,
          res.status,
        );
      }

      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new ProviderError("invalid_response", "Provider returned invalid JSON");
      }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new ProviderError("invalid_response", "Provider returned an empty response");
      }

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new ProviderError(
          "invalid_response",
          "Provider returned malformed structured output",
        );
      }

      try {
        const validated = validateProviderResponse(
          {
            segments: normalizeResponseSegments(parsed.segments, request.mode),
            finishReason: body.choices?.[0]?.finish_reason,
            requestId,
            usage: {
              promptTokens: body.usage?.prompt_tokens,
              completionTokens: body.usage?.completion_tokens,
            },
          },
          transportRequest.segments,
        );
        return {
          ...validated,
          segments: validated.segments.map((segment, index) => ({
            ...segment,
            id: request.segments[index].id,
          })),
        };
      } catch (error) {
        const fields = responseFieldSummary(parsed.segments);
        throw new ProviderError(
          "invalid_response",
          `${error instanceof Error ? error.message : "Invalid provider response"}${
            fields ? ` (received fields: ${fields})` : ""
          }`,
        );
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if ((error as Error).name === "AbortError") {
        throw new ProviderError("temporary", "Provider request timed out");
      }
      throw new ProviderError("temporary", "Provider request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
