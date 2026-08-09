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
  if (!Array.isArray(value) || mode !== "editing") {
    return value as ProviderResponse["segments"];
  }
  return value.map((segment) => {
    if (typeof segment !== "object" || segment === null || !("id" in segment)) return segment;
    if ("text" in segment && typeof segment.text === "string") return segment;
    if ("draft" in segment && typeof segment.draft === "string") {
      return { id: segment.id, text: segment.draft };
    }
    return segment;
  }) as ProviderResponse["segments"];
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
        throw new ProviderError(
          "invalid_response",
          error instanceof Error ? error.message : "Invalid provider response",
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
