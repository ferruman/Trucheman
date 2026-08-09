import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../../src/server/providers/deepseek.js";

describe("DeepSeek provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires a server-side credential", async () => {
    await expect(
      new DeepSeekProvider().complete({
        profile: { name: "x", endpoint: "x", model: "x" },
        mode: "translation",
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
      instructions: "Translate from English to Russian",
      segments: [{ id: "document-3:a", text: "Hello" }],
    });

    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).not.toContain("Hello");
    expect(JSON.parse(messages[1]?.content ?? "").segments).toEqual([
      { id: "s0001", text: "Hello" },
    ]);
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
                        { id: "s0001", original: "Unknown", edited_text: "Неизвестно" },
                        { id: "s0002", original: "Part", polished: "Часть" },
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
