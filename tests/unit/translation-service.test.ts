import { describe, expect, it } from "vitest";
import { processBatch } from "../../src/server/jobs/translation-service.js";
import { ProviderError, type LanguageModelProvider } from "../../src/server/providers/provider.js";

describe("translation service", () => {
  it("forwards the prompt version selected by the provider profile", async () => {
    let promptVersion: string | undefined;
    const provider: LanguageModelProvider = {
      async complete(request) {
        promptVersion = request.promptVersion;
        return { segments: [{ id: "segment-1", text: "Отредактировано" }] };
      },
    };

    await processBatch(
      provider,
      {
        name: "terra-editing",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-5.6-terra",
        promptVersion: "literary-v3.2.1",
      },
      "editing",
      [{ id: "segment-1", original: "Edited", draft: "Черновик" }],
      {
        sourceLanguage: { tag: "en", name: "English" },
        targetLanguage: { tag: "ru", name: "Russian" },
      },
      "",
      [],
      0,
    );

    expect(promptVersion).toBe("literary-v3.2.1");
  });

  it("splits a prepared batch with many short segments before calling the provider", async () => {
    const requestSizes: number[] = [];
    const provider: LanguageModelProvider = {
      async complete(request) {
        requestSizes.push(request.segments.length);
        if (request.segments.length > 20) {
          throw new Error("Provider response IDs do not exactly match the request");
        }
        return {
          segments: request.segments.map((segment) => ({
            id: segment.id,
            text: "text" in segment ? `[translated] ${segment.text}` : segment.draft,
          })),
          finishReason: "stop",
        };
      },
    };
    const segments = Array.from({ length: 52 }, (_, index) => ({
      id: `document-3:${index.toString(36)}`,
      text: `segment ${index}`,
    }));

    const result = await processBatch(
      provider,
      { name: "test", endpoint: "local", model: "test" },
      "translation",
      segments,
      {
        sourceLanguage: { tag: "en", name: "English" },
        targetLanguage: { tag: "ru", name: "Russian" },
      },
      "",
      [],
      0,
    );

    expect(requestSizes).toEqual([20, 20, 12]);
    expect(result.result.segments.map((segment) => segment.id)).toEqual(
      segments.map((segment) => segment.id),
    );
    expect(result.attempts).toBe(3);
  });

  it("splits a batch the model cannot answer in valid JSON instead of failing the run", async () => {
    const requestIds: string[][] = [];
    const provider: LanguageModelProvider = {
      async complete(request) {
        const ids = request.segments.map((segment) => segment.id);
        requestIds.push(ids);
        // The whole batch is unanswerable; either half is fine.
        if (ids.length > 2) throw new ProviderError("invalid_response", "malformed output");
        return { segments: request.segments.map((segment) => ({ id: segment.id, text: "ок" })) };
      },
    };

    const segments = ["s1", "s2", "s3", "s4"].map((id) => ({ id, text: id }));
    const result = await processBatch(
      provider,
      { name: "test", endpoint: "local", model: "test" },
      "translation",
      segments,
      {
        sourceLanguage: { tag: "en", name: "English" },
        targetLanguage: { tag: "ru", name: "Russian" },
      },
      "",
      [],
      1,
    );

    expect(requestIds).toEqual([
      ["s1", "s2", "s3", "s4"],
      ["s1", "s2", "s3", "s4"],
      ["s1", "s2"],
      ["s3", "s4"],
    ]);
    expect(result.result.segments.map((segment) => segment.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("gives up when a single segment still cannot be answered", async () => {
    const provider: LanguageModelProvider = {
      async complete() {
        throw new ProviderError("invalid_response", "malformed output");
      },
    };

    await expect(
      processBatch(
        provider,
        { name: "test", endpoint: "local", model: "test" },
        "translation",
        [{ id: "s1", text: "one" }],
        {
          sourceLanguage: { tag: "en", name: "English" },
          targetLanguage: { tag: "ru", name: "Russian" },
        },
        "",
        [],
        0,
      ),
    ).rejects.toThrow("malformed output");
  });

  it("recovers only empty output segments instead of repeating the whole batch", async () => {
    const requestIds: string[][] = [];
    const provider: LanguageModelProvider = {
      async complete(request) {
        requestIds.push(request.segments.map((segment) => segment.id));
        if (request.segments.length > 1) {
          throw new ProviderError(
            "invalid_response",
            "One empty segment",
            undefined,
            { promptTokens: 100, completionTokens: 20 },
            "partial-request",
            {
              segments: [
                { id: "s1", text: "Что ты" },
                { id: "s2", text: "" },
                { id: "s3", text: "хочешь?" },
              ],
            },
          );
        }
        return { segments: [{ id: request.segments[0].id, text: "ты" }] };
      },
    };

    const result = await processBatch(
      provider,
      { name: "test", endpoint: "local", model: "test" },
      "translation",
      [
        { id: "s1", text: "What do" },
        { id: "s2", text: "you" },
        { id: "s3", text: "want?" },
      ],
      {
        sourceLanguage: { tag: "en", name: "English" },
        targetLanguage: { tag: "ru", name: "Russian" },
      },
      "",
      [],
      0,
    );

    expect(requestIds).toEqual([["s1", "s2", "s3"], ["s2"]]);
    expect(result.result.segments).toEqual([
      { id: "s1", text: "Что ты" },
      { id: "s2", text: "ты" },
      { id: "s3", text: "хочешь?" },
    ]);
    expect(result.attempts).toBe(2);
  });
});
