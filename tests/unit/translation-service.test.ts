import { describe, expect, it } from "vitest";
import { processBatch } from "../../src/server/jobs/translation-service.js";
import { ProviderError, type LanguageModelProvider } from "../../src/server/providers/provider.js";

const languages = {
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
};

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

  it("splits a context-limited batch immediately and preserves segment order", async () => {
    const requestIds: string[][] = [];
    const provider: LanguageModelProvider = {
      async complete(request) {
        const ids = request.segments.map((segment) => segment.id);
        requestIds.push(ids);
        if (ids.length > 2) {
          throw new ProviderError("request_too_large", "context_length_exceeded", 400);
        }
        return { segments: ids.map((id) => ({ id, text: `ok:${id}` })) };
      },
    };
    const segments = ["s1", "s2", "s3", "s4"].map((id) => ({ id, text: id }));

    const result = await processBatch(
      provider,
      { name: "test", endpoint: "local", model: "test" },
      "translation",
      segments,
      languages,
      "",
      [],
      3,
    );

    expect(requestIds).toEqual([
      ["s1", "s2", "s3", "s4"],
      ["s1", "s2"],
      ["s3", "s4"],
    ]);
    expect(result.result.segments.map(({ id }) => id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(result.attempts).toBe(3);
  });

  it("uses deterministic child IDs when one translation segment exceeds context", async () => {
    const requested: Array<{ id: string; text: string }> = [];
    const provider: LanguageModelProvider = {
      async complete(request) {
        const segment = request.segments[0];
        if (!("text" in segment)) throw new Error("translation input expected");
        requested.push({ id: segment.id, text: segment.text });
        if (segment.text.length > 18) {
          throw new ProviderError("request_too_large", "payload too large", 413);
        }
        return { segments: [{ id: segment.id, text: segment.text.toUpperCase() }] };
      },
    };
    const source = "one two three four five six seven eight";

    const result = await processBatch(
      provider,
      { name: "test", endpoint: "local", model: "test" },
      "translation",
      [{ id: "chapter:1", text: source }],
      languages,
      "",
      [],
      0,
    );

    expect(requested[0]).toEqual({ id: "chapter:1", text: source });
    expect(requested.slice(1).map(({ id }) => id)).toEqual([
      "chapter:1~adaptive-1",
      "chapter:1~adaptive-2",
      "chapter:1~adaptive-2~adaptive-1",
      "chapter:1~adaptive-2~adaptive-2",
    ]);
    expect(
      requested
        .filter(({ text }) => text.length <= 18)
        .map(({ text }) => text)
        .join(" "),
    ).toBe(source);
    expect(result.result.segments).toEqual([{ id: "chapter:1", text: source.toUpperCase() }]);
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
