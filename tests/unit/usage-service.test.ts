import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  LanguageModelProvider,
  ProviderRequest,
  ProviderResponse,
} from "../../src/server/providers/provider.js";
import { ProviderError } from "../../src/server/providers/provider.js";
import {
  UsageTrackingProvider,
  buildUsageReport,
  readUsageReport,
  type UsageRecord,
} from "../../src/server/jobs/usage-service.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    version: 1,
    recordedAt: "2026-08-10T00:00:00.000Z",
    callId: crypto.randomUUID(),
    stage: "editing",
    profile: "editor",
    endpoint: "https://example.test/chat",
    model: "editor-model",
    promptTokens: 100,
    cachedPromptTokens: 20,
    completionTokens: 30,
    totalTokens: 130,
    ...overrides,
  };
}

describe("model usage tracking", () => {
  it("groups actual token usage by pipeline stage and model", () => {
    const report = buildUsageReport([
      record(),
      record({ promptTokens: 50, cachedPromptTokens: 0, completionTokens: 10, totalTokens: 60 }),
      record({
        stage: "audit",
        profile: "critic",
        model: "critic-model",
        promptTokens: 80,
        cachedPromptTokens: null,
        completionTokens: 5,
        totalTokens: 85,
      }),
    ]);

    expect(report.totals).toEqual({
      requests: 3,
      requestsWithUsage: 3,
      failedRequests: 0,
      invalidResponses: 0,
      timeouts: 0,
      promptTokens: 230,
      cachedPromptTokens: 20,
      completionTokens: 45,
      totalTokens: 275,
    });
    expect(report.breakdown).toMatchObject([
      { stage: "editing", model: "editor-model", requests: 2, totalTokens: 190 },
      { stage: "audit", model: "critic-model", requests: 1, totalTokens: 85 },
    ]);
  });

  it("journals each successful provider call and publishes a current report", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-usage-"));
    roots.push(root);
    const provider: LanguageModelProvider = {
      async complete(request): Promise<ProviderResponse> {
        return {
          requestId: `request-${request.mode}`,
          segments: request.segments.map((segment) => ({ id: segment.id, text: "ok" })),
          usage: {
            promptTokens: request.mode === "translation" ? 120 : 90,
            cachedPromptTokens: request.mode === "editing" ? 30 : 0,
            completionTokens: 20,
          },
        };
      },
    };
    const tracked = new UsageTrackingProvider(provider, root);
    const request = (mode: ProviderRequest["mode"], model: string): ProviderRequest => ({
      profile: { name: mode, endpoint: "https://example.test/chat", model, apiKey: "secret" },
      mode,
      sourceLanguage: { tag: "en", name: "English" },
      targetLanguage: { tag: "ru", name: "Russian" },
      segments: [{ id: "s1", text: "Hello" }],
    });

    await tracked.complete(request("translation", "translator-model"));
    await tracked.complete(request("editing", "editor-model"));

    const report = await readUsageReport(root);
    expect(report.breakdown).toMatchObject([
      { stage: "translation", model: "translator-model", requests: 1, totalTokens: 140 },
      {
        stage: "editing",
        model: "editor-model",
        requests: 1,
        cachedPromptTokens: 30,
        totalTokens: 110,
      },
    ]);
    expect(JSON.parse(await readFile(join(root, "usage-report.json"), "utf8"))).toMatchObject({
      totals: { requests: 2, totalTokens: 250 },
    });
    expect(await readFile(join(root, "usage.ndjson"), "utf8")).not.toContain("secret");
  });

  it("counts requests even when a provider omits token usage", () => {
    const report = buildUsageReport([
      record({
        promptTokens: null,
        cachedPromptTokens: null,
        completionTokens: null,
        totalTokens: null,
      }),
    ]);
    expect(report.totals).toMatchObject({ requests: 1, requestsWithUsage: 0, totalTokens: 0 });
  });

  it("records billed usage from an invalid provider response before rethrowing", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-failed-usage-"));
    roots.push(root);
    const provider: LanguageModelProvider = {
      async complete() {
        throw new ProviderError(
          "invalid_response",
          "Malformed response",
          undefined,
          { promptTokens: 200, completionTokens: 10 },
          "failed-request",
        );
      },
    };
    const tracked = new UsageTrackingProvider(provider, root);

    await expect(
      tracked.complete({
        profile: { name: "editor", endpoint: "https://example.test", model: "editor-model" },
        mode: "editing",
        sourceLanguage: { tag: "en", name: "English" },
        targetLanguage: { tag: "ru", name: "Russian" },
        segments: [{ id: "s1", original: "Hello", draft: "Привет" }],
      }),
    ).rejects.toThrow("Malformed response");

    expect(await readUsageReport(root)).toMatchObject({
      totals: {
        requests: 1,
        promptTokens: 200,
        completionTokens: 10,
        totalTokens: 210,
        failedRequests: 1,
        invalidResponses: 1,
      },
    });
  });

  it("separates timeouts and invalid responses per stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-outcome-usage-"));
    roots.push(root);
    const failures: Record<string, ProviderError> = {
      audit: new ProviderError("invalid_response", "Provider returned malformed structured output"),
      consistency: new ProviderError("temporary", "Provider request timed out"),
    };
    const provider: LanguageModelProvider = {
      async complete(request) {
        const failure = failures[request.mode];
        if (failure) throw failure;
        return {
          segments: request.segments.map((segment) => ({ id: segment.id, text: "ok" })),
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    };
    const tracked = new UsageTrackingProvider(provider, root);
    const call = (mode: ProviderRequest["mode"]) =>
      tracked
        .complete({
          profile: { name: mode, endpoint: "https://example.test", model: "m" },
          mode,
          sourceLanguage: { tag: "en", name: "English" },
          targetLanguage: { tag: "ru", name: "Russian" },
          segments: [{ id: "s1", text: "Hello" }],
        })
        .catch(() => undefined);

    await call("translation");
    await call("audit");
    await call("consistency");

    const report = await readUsageReport(root);
    expect(report.totals).toMatchObject({
      requests: 3,
      failedRequests: 2,
      invalidResponses: 1,
      timeouts: 1,
    });
    // Cached checkpoints never call the provider, so they never inflate this count.
    expect(report.breakdown.map((row) => row.stage)).toEqual([
      "translation",
      "audit",
      "consistency",
    ]);
  });
});
