import { describe, expect, it } from "vitest";
import { processBatch } from "../../src/server/jobs/translation-service.js";
import type { LanguageModelProvider } from "../../src/server/providers/provider.js";

describe("translation service", () => {
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
});
