import { parseAuditSegments } from "./audit-contract.js";
import { buildPromptMessages } from "./prompts.js";
import {
  isRequestTooLargeFailure,
  ProviderError,
  type LanguageModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./provider.js";
import { misalignedSegmentIds, validateProviderResponse } from "./response-validator.js";
import { abortableDelay } from "./retry-policy.js";
import { isEndpointHost } from "../config/endpoint.js";

function withTransportIds(request: ProviderRequest): ProviderRequest {
  return {
    ...request,
    segments: request.segments.map((segment, index) => ({
      ...segment,
      id: `s${String(index + 1).padStart(4, "0")}`,
    })),
  };
}

/** The request body shared by synchronous chat completions and OpenAI Batch API jobs. */
export function chatCompletionRequestBody(request: ProviderRequest) {
  const transportRequest = withTransportIds(request);
  return {
    model: request.profile.model,
    messages: buildPromptMessages(transportRequest),
    response_format: { type: "json_object" },
    temperature: request.profile.temperature,
    thinking:
      request.profile.thinking && !isEndpointHost(request.profile.endpoint, "api.openai.com")
        ? { type: request.profile.thinking }
        : undefined,
    stream: false,
  };
}

function normalizeResponseSegments(
  value: unknown,
  mode: ProviderRequest["mode"],
): ProviderResponse["segments"] {
  if (!Array.isArray(value)) {
    return value as ProviderResponse["segments"];
  }
  if (mode === "consistency") {
    // The answer is a structure; `text` carries its canonical serialization, written here so
    // the model never has to escape a JSON document inside a JSON string. A model that
    // stringified it anyway is still right, and its string is already what the caller parses.
    return value.map((segment) => {
      if (typeof segment !== "object" || segment === null || !("id" in segment)) return segment;
      const { id, text } = segment as { id: unknown; text: unknown };
      return { id, text: typeof text === "string" ? text : JSON.stringify(text) };
    }) as ProviderResponse["segments"];
  }
  const preferredFields =
    mode === "editing" || mode === "repair"
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

function preserveInputForEmptyEdits(
  segments: ProviderResponse["segments"],
  request: ProviderRequest,
): ProviderResponse["segments"] {
  if (request.mode !== "editing" && request.mode !== "repair") return segments;
  return segments.map((segment, index) => {
    if (typeof segment?.text !== "string" || segment.text.trim()) return segment;
    const input = request.segments[index];
    const fallback =
      input && "draft" in input
        ? input.draft
        : input && "editedTranslation" in input
          ? input.editedTranslation
          : undefined;
    return typeof fallback === "string" && fallback.length
      ? { id: segment.id, text: fallback }
      : segment;
  });
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

function parseTransportBody(text: string): unknown {
  const normalized = text.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(normalized);
  } catch (initialError) {
    const payloads = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    if (payloads.length === 1) return JSON.parse(payloads[0]);
    throw initialError;
  }
}

/**
 * What actually went wrong underneath `fetch`. Node reports every transport failure as
 * "fetch failed" and hides the distinction in `cause.code`, which is the only part worth
 * keeping: a system error code names the fault without carrying a URL or a credential.
 */
export function transportCause(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown })?.code;
  if (typeof code === "string" && code) return code;
  const message =
    (cause as { message?: unknown })?.message ?? (error as { message?: unknown })?.message;
  return typeof message === "string" && message.trim() ? message.slice(0, 120) : "no cause";
}

function transportBodyShape(text: string, contentType: string | null) {
  const trimmed = text.trimStart();
  const form = trimmed.startsWith("<")
    ? "markup"
    : trimmed.startsWith("data:")
      ? "event-stream"
      : trimmed.startsWith("{") || trimmed.startsWith("[")
        ? "truncated-json"
        : trimmed
          ? "plain-text"
          : "empty";
  return `content-type ${contentType ?? "missing"}, ${Buffer.byteLength(text)} bytes, ${form}`;
}

/**
 * `JSON.parse`, remembering which text the position in its error message counts from. The
 * candidates below are all substrings of the answer, so without this a reported position
 * reads as an offset into the wrong string.
 */
function parseFrom(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Object.assign(error as Error, { parsedText: text });
  }
}

function parseStructuredContent(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch (initialError) {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    if (fenced) return parseFrom(fenced);
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return parseFrom(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw Object.assign(initialError as Error, { parsedText: trimmed });
  }
}

/**
 * The 60 characters either side of where JSON.parse gave up.
 *
 * "Expected ',' or ']' at position 1076" of a 1137-byte answer that finished normally says
 * the model wrote bad JSON, not that it ran out of room — but not which of the book's own
 * characters it choked on, and the answer itself is never kept. This window is what turns
 * the next occurrence into a fix instead of a guess. It is model output about the book, in
 * the book's own job directory, and it goes through the same redaction and 300-character
 * cap as every other usage detail.
 */
function parseErrorContext(content: string, error: unknown): string {
  const position = Number(/position (\d+)/.exec(String(error))?.[1]);
  if (!Number.isFinite(position)) return "";
  const parsed = (error as { parsedText?: string }).parsedText ?? content;
  const window = parsed.slice(Math.max(0, position - 60), position + 60).replace(/\s+/gu, " ");
  return ` near: ${window}`;
}

/**
 * Audit responses are validated against their own schema, per segment. A segment whose
 * issues are unusable is marked `invalid_issues` and the rest of the batch survives.
 */
function auditResponse(
  parsed: unknown,
  request: ProviderRequest,
  transportIds: string[],
  usage: ProviderResponse["usage"],
  requestId?: string,
): ProviderResponse {
  const audited = parseAuditSegments(parsed, transportIds);
  return {
    segments: audited.map((segment, index) => ({
      id: request.segments[index].id,
      // Canonical serialization written here, never by the model; journals keep one shape.
      text: JSON.stringify({ issues: segment.issues, auditError: segment.auditError }),
      issues: segment.issues,
    })),
    finishReason: "stop",
    usage,
    requestId,
  };
}

/** Parse the common OpenAI-compatible chat-completion envelope into Trucheman's contract. */
export function parseChatCompletionBody(
  body: unknown,
  request: ProviderRequest,
  requestId?: string,
): ProviderResponse {
  const envelope = body as {
    usage?: {
      prompt_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      prompt_cache_hit_tokens?: number;
      completion_tokens?: number;
    };
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  };
  const transportRequest = withTransportIds(request);
  const usage: ProviderResponse["usage"] = {
    promptTokens: envelope.usage?.prompt_tokens,
    cachedPromptTokens:
      envelope.usage?.prompt_tokens_details?.cached_tokens ??
      envelope.usage?.prompt_cache_hit_tokens,
    completionTokens: envelope.usage?.completion_tokens,
  };
  const content = envelope.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ProviderError(
      "invalid_response",
      "Provider returned an empty response",
      undefined,
      usage,
      requestId,
    );
  }

  let parsed: any;
  try {
    parsed = parseStructuredContent(content);
  } catch (parseError) {
    throw new ProviderError(
      "invalid_response",
      `Provider returned malformed structured output (${Buffer.byteLength(content)} bytes, ${
        envelope.choices?.[0]?.finish_reason ?? "no finish reason"
      }: ${
        parseError instanceof Error ? parseError.message : "unparseable"
      })${parseErrorContext(content, parseError)}`,
      undefined,
      usage,
      requestId,
    );
  }

  if (request.mode === "consistency" && !Array.isArray(parsed?.segments)) {
    parsed = { segments: [{ id: transportRequest.segments[0]?.id, text: parsed }] };
  }

  if (request.mode === "audit") {
    if (!Array.isArray(parsed?.segments) || parsed.segments.length !== request.segments.length) {
      throw new ProviderError(
        "invalid_response",
        `Audit response must contain ${request.segments.length} segments`,
        undefined,
        usage,
        requestId,
      );
    }
    return auditResponse(
      parsed,
      request,
      transportRequest.segments.map((segment) => segment.id),
      usage,
      requestId,
    );
  }

  const candidate: ProviderResponse = {
    segments: preserveInputForEmptyEdits(
      normalizeResponseSegments(parsed.segments, request.mode),
      transportRequest,
    ),
    finishReason: envelope.choices?.[0]?.finish_reason,
    requestId,
    usage,
  };
  try {
    const validated = validateProviderResponse(candidate, transportRequest.segments);
    const answer = {
      ...validated,
      segments: validated.segments.map((segment, index) => ({
        ...segment,
        id: request.segments[index].id,
      })),
    };
    if (request.mode === "translation" || request.mode === "editing") {
      const misaligned = misalignedSegmentIds(request.segments, answer.segments);
      if (misaligned.length) {
        throw new Error(
          `Provider answer runs into the next segment at ${misaligned.slice(0, 3).join(", ")}`,
        );
      }
    }
    return answer;
  } catch (error) {
    const fields = responseFieldSummary(parsed.segments);
    throw new ProviderError(
      "invalid_response",
      `${error instanceof Error ? error.message : "Invalid provider response"}${
        fields ? ` (received fields: ${fields})` : ""
      }`,
      undefined,
      usage,
      requestId,
      {
        ...candidate,
        segments: candidate.segments.map((segment, index) => ({
          ...segment,
          id: request.segments[index]?.id ?? segment.id,
        })),
      },
    );
  }
}

/**
 * `Retry-After` as milliseconds: the header is either delta-seconds or an HTTP date.
 * A pause longer than the cap is treated as no pause — the caller's bounded backoff and
 * its checkpoints are a better answer than parking a worker for an hour.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_RETRY_AFTER_MS ? Math.ceil(ms) : undefined;
}

const MAX_RETRY_AFTER_MS = 60_000;

export class DeepSeekProvider implements LanguageModelProvider {
  /**
   * Batches run concurrently against one provider instance, so a 429 has to hold every
   * worker back, not just the one that got it. Otherwise the others keep spending the
   * rate limit the server just asked us to stop using.
   */
  private cooldownUntil = 0;

  async complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    if (!request.profile.apiKey) {
      throw new ProviderError("configuration", "Provider credential is not configured");
    }
    const cooldown = this.cooldownUntil - Date.now();
    if (cooldown > 0) await abortableDelay(cooldown, signal);

    // The job-level signal outlives every batch, so a per-request listener on it would
    // accumulate for the whole run. AbortSignal.any owns that wiring and releases it.
    const timeout = AbortSignal.timeout(request.profile.timeoutMs ?? 60000);
    const aborted = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let observedRequestId: string | undefined;

    try {
      const res = await fetch(request.profile.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.profile.apiKey}`,
        },
        body: JSON.stringify(chatCompletionRequestBody(request)),
        signal: aborted,
      });
      observedRequestId = res.headers.get("x-request-id") ?? undefined;
      if (!res.ok) {
        const errorBody =
          res.status === 400 || res.status === 413 || res.status === 422
            ? await res.text().catch(() => "")
            : "";
        if (isRequestTooLargeFailure(res.status, errorBody)) {
          throw new ProviderError(
            "request_too_large",
            `Provider request exceeds the model context (${res.status})`,
            res.status,
          );
        }
        if (res.status === 401 || res.status === 403 || res.status === 400) {
          throw new ProviderError(
            "configuration",
            `Provider rejected configuration (${res.status})`,
            res.status,
          );
        }
        // 402 is a state of the account, not of the moment: no amount of waiting turns it into
        // a success. Retrying it burned six attempts against a wall on every batch in flight
        // and reported "temporarily unavailable" for a book that had simply run out of credit.
        if (res.status === 402) {
          throw new ProviderError(
            "configuration",
            "Provider credit is exhausted (402); top up the account and resume the job",
            res.status,
          );
        }
        const pause = retryAfterMs(res.headers.get("retry-after"));
        if (pause) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + pause);
        throw new ProviderError(
          "temporary",
          `Provider temporarily unavailable (${res.status})`,
          res.status,
        );
      }

      const responseText = await res.text();
      let body: any;
      try {
        body = parseTransportBody(responseText);
      } catch {
        throw new ProviderError(
          "invalid_response",
          `Provider returned invalid JSON (${transportBodyShape(
            responseText,
            res.headers.get("content-type"),
          )})`,
        );
      }
      return parseChatCompletionBody(body, request, observedRequestId);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // A paused job must propagate its own reason: wrapping it as "temporary" would
      // make the retry policy keep calling the provider after the user asked to stop.
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Job aborted");
      }
      if (timeout.aborted) {
        throw new ProviderError("temporary", "Provider request timed out");
      }
      // `fetch` reports every transport failure as the same "fetch failed", and puts the
      // difference — ECONNRESET, ENOTFOUND, a socket closed mid-body — in `cause`. Dropping
      // it left four books' worth of runs saying only "Provider request failed", which does
      // not distinguish a dropped connection from a wrong endpoint.
      throw new ProviderError("temporary", `Provider request failed (${transportCause(error)})`);
    }
  }
}
