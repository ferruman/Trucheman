import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiBatchProvider } from "../../src/server/providers/openai-batch.js";
import type { ProviderRequest } from "../../src/server/providers/provider.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "trucheman-openai-batch-"));
  roots.push(value);
  return value;
}

const request: ProviderRequest = {
  profile: {
    name: "openai-translation",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "test-model",
    apiKey: "secret",
  },
  mode: "translation",
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
  segments: [{ id: "segment-1", text: "Hello" }],
};

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function completedOutput() {
  return `${JSON.stringify({
    custom_id: "trucheman-request",
    response: {
      status_code: 200,
      request_id: "batch-request-1",
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ segments: [{ id: "s0001", text: "Привет" }] }) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
    },
    error: null,
  })}\n`;
}

describe("OpenAiBatchProvider", () => {
  it("resumes a submitted remote batch after a local pause and caches its output", async () => {
    const dataRoot = await root();
    const controller = new AbortController();
    let uploads = 0;
    let creations = 0;
    let statusChecks = 0;
    let downloads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/files") && init?.method === "POST") {
        uploads++;
        return json({ id: "file-input" });
      }
      if (url.endsWith("/v1/batches") && init?.method === "POST") {
        creations++;
        return json({ id: "batch-1", status: "validating", input_file_id: "file-input" });
      }
      if (url.endsWith("/v1/batches/batch-1")) {
        statusChecks++;
        if (statusChecks === 1) {
          controller.abort(new Error("Job paused"));
          return json({ id: "batch-1", status: "in_progress", input_file_id: "file-input" });
        }
        return json({
          id: "batch-1",
          status: "completed",
          input_file_id: "file-input",
          output_file_id: "file-output",
        });
      }
      if (url.endsWith("/v1/files/file-output/content")) {
        downloads++;
        return new Response(completedOutput());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(
      new OpenAiBatchProvider(dataRoot, {
        fetch: fetcher as typeof fetch,
        pollIntervalMs: 0,
      }).complete(request, controller.signal),
    ).rejects.toThrow("Job paused");

    const resumed = await new OpenAiBatchProvider(dataRoot, {
      fetch: fetcher as typeof fetch,
      pollIntervalMs: 0,
    }).complete(request);
    expect(resumed).toMatchObject({
      segments: [{ id: "segment-1", text: "Привет" }],
      requestId: "batch-request-1",
      usage: { promptTokens: 10, completionTokens: 4 },
    });
    expect({ uploads, creations, statusChecks, downloads }).toEqual({
      uploads: 1,
      creations: 1,
      statusChecks: 2,
      downloads: 1,
    });

    const cached = await new OpenAiBatchProvider(dataRoot, {
      fetch: vi.fn(() => {
        throw new Error("cached output must not use the network");
      }) as unknown as typeof fetch,
    }).complete(request);
    expect(cached.segments[0].text).toBe("Привет");
  });

  it("rejects non-OpenAI endpoints before uploading book text", async () => {
    const fetcher = vi.fn();
    await expect(
      new OpenAiBatchProvider(await root(), { fetch: fetcher as typeof fetch }).complete({
        ...request,
        profile: { ...request.profile, endpoint: "https://api.deepseek.com/chat/completions" },
      }),
    ).rejects.toThrow("requires https://api.openai.com/v1/chat/completions");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
