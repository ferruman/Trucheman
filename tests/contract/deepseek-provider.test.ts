import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../../src/server/providers/deepseek.js";

const languages = {
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
};

describe("DeepSeek provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires a server-side credential", async () => {
    await expect(
      new DeepSeekProvider().complete({
        profile: { name: "x", endpoint: "x", model: "x" },
        mode: "translation",
        ...languages,
        segments: [],
      }),
    ).rejects.toMatchObject({ kind: "configuration" });
  });

  it("sends rules and book data in separate messages", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '{"segments":[{"id":"s0001","text":"Привет"}]}' },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const response = await new DeepSeekProvider().complete({
      profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
      mode: "translation",
      ...languages,
      instructions: "Preserve formal dialogue",
      segments: [{ id: "document-3:a", text: "Hello" }],
    });

    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).not.toContain("Hello");
    const input = JSON.parse(messages[1]?.content ?? "");
    expect(input.responseContract).toEqual({
      format: "json",
      segmentCount: 1,
      ids: ["s0001"],
      segmentKeys: ["id", "text"],
      textType: "string",
    });
    expect(input.sourceLanguage).toEqual({ tag: "en", name: "English" });
    expect(input.targetLanguage).toEqual({ tag: "ru", name: "Russian" });
    expect(input.userPreferences).toBe("Preserve formal dialogue");
    expect(input.segments).toEqual([{ id: "s0001", text: "Hello" }]);
    expect(response.segments).toEqual([{ id: "document-3:a", text: "Привет" }]);
  });

  it("normalizes alternate editing fields while preserving the original segment IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      segments: [
                        {
                          id: "s0001",
                          text: { edited_text: "Неизвестно" },
                        },
                        { id: "s0002", text: { value: "Часть" } },
                      ],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const response = await new DeepSeekProvider().complete({
      profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
      mode: "editing",
      ...languages,
      segments: [
        { id: "document-3:0", original: "Unknown", draft: "Неизвестно" },
        { id: "document-3:1", original: "Part", draft: "Часть" },
      ],
    });

    expect(response.segments).toEqual([
      { id: "document-3:0", text: "Неизвестно" },
      { id: "document-3:1", text: "Часть" },
    ]);
  });
});
