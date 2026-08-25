import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, atomicWrite } from "../storage/atomic-file.js";
import { abortableDelay } from "./retry-policy.js";
import {
  chatCompletionRequestBody,
  parseChatCompletionBody,
  transportCause,
} from "./openai-chat.js";
import {
  isRequestTooLargeFailure,
  ProviderError,
  type LanguageModelProvider,
  type ProviderProfile,
  type ProviderRequest,
  type ProviderResponse,
} from "./provider.js";

const OPENAI_ORIGIN = "https://api.openai.com";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

type BatchRecord = {
  version: 1;
  requestKey: string;
  inputFileId: string;
  batchId?: string;
  outputFileId?: string;
  createdAt: string;
};

type OpenAiBatch = {
  id: string;
  status: string;
  input_file_id: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  errors?: { data?: Array<{ message?: string }> } | null;
};

type BatchOutput = {
  custom_id?: string;
  response?: { status_code?: number; request_id?: string; body?: unknown };
  error?: { message?: string } | null;
};

export function assertOpenAiBatchProfile(profile: ProviderProfile): void {
  let endpoint: URL;
  try {
    endpoint = new URL(profile.endpoint);
  } catch {
    throw new ProviderError("configuration", "OpenAI Batch mode requires a valid endpoint URL");
  }
  if (endpoint.origin !== OPENAI_ORIGIN || endpoint.pathname !== CHAT_COMPLETIONS_PATH) {
    throw new ProviderError(
      "configuration",
      `OpenAI Batch mode requires ${OPENAI_ORIGIN}${CHAT_COMPLETIONS_PATH}`,
    );
  }
  if (!profile.apiKey) {
    throw new ProviderError("configuration", "OpenAI Batch mode requires an API key");
  }
}

function requestKey(request: ProviderRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        endpoint: request.profile.endpoint,
        body: chatCompletionRequestBody(request),
      }),
    )
    .digest("hex");
}

function authorization(apiKey: string) {
  return { authorization: `Bearer ${apiKey}` };
}

async function responseJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const kind = isRequestTooLargeFailure(response.status, body)
      ? "request_too_large"
      : [400, 401, 403, 404].includes(response.status)
        ? "configuration"
        : "temporary";
    throw new ProviderError(kind, `${operation} failed (${response.status})`, response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError("invalid_response", `${operation} returned invalid JSON`);
  }
}

function batchFailure(batch: OpenAiBatch): string {
  return (
    batch.errors?.data?.find((error) => error.message)?.message ?? `OpenAI batch ${batch.status}`
  );
}

export class OpenAiBatchProvider implements LanguageModelProvider {
  constructor(
    private readonly root: string,
    private readonly options: {
      fetch?: typeof fetch;
      pollIntervalMs?: number;
    } = {},
  ) {}

  async complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    assertOpenAiBatchProfile(request.profile);
    const key = requestKey(request);
    const directory = join(this.root, "openai-batches");
    const statePath = join(directory, `${key}.json`);
    const outputPath = join(directory, `${key}.output.jsonl`);
    const fetcher = this.options.fetch ?? fetch;
    const apiKey = request.profile.apiKey!;

    try {
      const cached = await readFile(outputPath, "utf8").catch(() => undefined);
      if (cached !== undefined) {
        try {
          return this.parseOutput(cached, request);
        } catch (error) {
          await Promise.all([rm(outputPath, { force: true }), rm(statePath, { force: true })]);
          throw error;
        }
      }

      let record = await this.readRecord(statePath, key);
      if (!record) {
        const input = `${JSON.stringify({
          custom_id: "trucheman-request",
          method: "POST",
          url: CHAT_COMPLETIONS_PATH,
          body: chatCompletionRequestBody(request),
        })}\n`;
        const form = new FormData();
        form.append("purpose", "batch");
        form.append("file", new Blob([input], { type: "application/jsonl" }), "batch.jsonl");
        const uploaded = await responseJson<{ id: string }>(
          await fetcher(`${OPENAI_ORIGIN}/v1/files`, {
            method: "POST",
            headers: authorization(apiKey),
            body: form,
            signal,
          }),
          "OpenAI batch input upload",
        );
        record = {
          version: 1,
          requestKey: key,
          inputFileId: uploaded.id,
          createdAt: new Date().toISOString(),
        };
        await atomicJson(statePath, record);
      }

      if (!record.batchId) {
        const batch = await responseJson<OpenAiBatch>(
          await fetcher(`${OPENAI_ORIGIN}/v1/batches`, {
            method: "POST",
            headers: {
              ...authorization(apiKey),
              "content-type": "application/json",
            },
            body: JSON.stringify({
              input_file_id: record.inputFileId,
              endpoint: CHAT_COMPLETIONS_PATH,
              completion_window: "24h",
              metadata: { application: "trucheman", request_key: key.slice(0, 32) },
            }),
            signal,
          }),
          "OpenAI batch creation",
        );
        record = { ...record, batchId: batch.id };
        await atomicJson(statePath, record);
      }

      for (;;) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Job paused");
        }
        const batch = await responseJson<OpenAiBatch>(
          await fetcher(`${OPENAI_ORIGIN}/v1/batches/${record.batchId}`, {
            headers: authorization(apiKey),
            signal,
          }),
          "OpenAI batch status check",
        );
        if (batch.status === "completed" && batch.output_file_id) {
          const output = await fetcher(
            `${OPENAI_ORIGIN}/v1/files/${batch.output_file_id}/content`,
            { headers: authorization(apiKey), signal },
          );
          if (!output.ok) {
            throw new ProviderError(
              output.status === 404 ? "invalid_response" : "temporary",
              `OpenAI batch output download failed (${output.status})`,
              output.status,
            );
          }
          const text = await output.text();
          let parsed: ProviderResponse;
          try {
            parsed = this.parseOutput(text, request);
          } catch (error) {
            // A completed remote request can still contain a per-request HTTP error or malformed
            // model output. Do not cache that failure: the bounded caller retry must submit a new
            // request rather than replaying the same failed JSONL forever.
            await rm(statePath, { force: true });
            throw error;
          }
          await atomicWrite(outputPath, text);
          await atomicJson(statePath, { ...record, outputFileId: batch.output_file_id });
          return parsed;
        }
        if (["failed", "expired", "cancelled"].includes(batch.status)) {
          await rm(statePath, { force: true });
          const failure = batchFailure(batch);
          throw new ProviderError(
            batch.status === "failed" && isRequestTooLargeFailure(undefined, failure)
              ? "request_too_large"
              : batch.status === "failed"
                ? "configuration"
                : "temporary",
            failure,
          );
        }
        await abortableDelay(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, signal);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Job paused");
      }
      throw new ProviderError(
        "temporary",
        `OpenAI Batch API request failed (${transportCause(error)})`,
      );
    }
  }

  private async readRecord(path: string, key: string): Promise<BatchRecord | undefined> {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as BatchRecord;
      return value.version === 1 && value.requestKey === key && value.inputFileId
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  private parseOutput(text: string, request: ProviderRequest): ProviderResponse {
    const lines = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let output: BatchOutput | undefined;
    try {
      output = lines
        .map((line) => JSON.parse(line) as BatchOutput)
        .find((item) => item.custom_id === "trucheman-request");
    } catch {
      throw new ProviderError("invalid_response", "OpenAI batch output is not valid JSONL");
    }
    if (!output) {
      throw new ProviderError("invalid_response", "OpenAI batch output is missing the request");
    }
    if (output.error) {
      throw new ProviderError(
        "invalid_response",
        output.error.message ?? "OpenAI batch request failed",
      );
    }
    const status = output.response?.status_code;
    if (status !== 200 || !output.response?.body) {
      throw new ProviderError(
        isRequestTooLargeFailure(status, output.response?.body)
          ? "request_too_large"
          : status === 400 || status === 401 || status === 403
            ? "configuration"
            : "temporary",
        `OpenAI batch request failed (${status ?? "no status"})`,
        status,
      );
    }
    return parseChatCompletionBody(output.response.body, request, output.response.request_id);
  }
}
