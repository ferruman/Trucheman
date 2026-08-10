import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekProvider, retryAfterMs } from "../../src/server/providers/deepseek.js";
import { ProviderError } from "../../src/server/providers/provider.js";

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
      profile: {
        name: "x",
        endpoint: "https://provider.test",
        model: "x",
        apiKey: "secret",
        temperature: 0,
        thinking: "disabled",
      },
      mode: "translation",
      ...languages,
      instructions: "Preserve formal dialogue",
      segments: [{ id: "document-3:a", text: "Hello" }],
    });

    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(requestBody?.temperature).toBe(0);
    expect(requestBody?.thinking).toEqual({ type: "disabled" });
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
    expect(input.targetStyle).toEqual({
      yo: "Use ё consistently where standard Russian spelling requires it.",
      quotes: "Use «ёлочки» and nested „лапки“ consistently.",
    });
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

  it("preserves draft text when editing returns an empty segment", async () => {
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
                        { id: "s0001", text: "" },
                        { id: "s0002", text: "Исправлено" },
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
        { id: "document-3:5", original: "In", draft: "В" },
        { id: "document-3:6", original: "desert", draft: "пустыне" },
      ],
    });

    expect(response.segments).toEqual([
      { id: "document-3:5", text: "В" },
      { id: "document-3:6", text: "Исправлено" },
    ]);
  });

  it("accepts a single JSON payload wrapped as an event stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({
              choices: [
                {
                  message: { content: '{"segments":[{"id":"s0001","text":"Привет"}]}' },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            })}\n\ndata: [DONE]\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );

    const response = await new DeepSeekProvider().complete({
      profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
      mode: "translation",
      ...languages,
      segments: [{ id: "document-1:0", text: "Hello" }],
    });

    expect(response.segments).toEqual([{ id: "document-1:0", text: "Привет" }]);
    expect(response.usage).toMatchObject({ promptTokens: 10, completionTokens: 2 });
  });

  it("describes an invalid transport response without echoing its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>private upstream failure</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(
      new DeepSeekProvider().complete({
        profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
        mode: "translation",
        ...languages,
        segments: [{ id: "document-1:0", text: "Hello" }],
      }),
    ).rejects.toThrow(/content-type text\/html, \d+ bytes, markup/);
  });

  it("reports malformed critic content as retryable rather than silently accepting it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"segments":[' }, finish_reason: "stop" }],
              usage: { prompt_tokens: 20, completion_tokens: 3 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const request = {
      profile: { name: "critic", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
      mode: "audit" as const,
      ...languages,
      segments: [
        {
          id: "document-1:0",
          original: "Hello",
          initialTranslation: "Привет",
          editedTranslation: "Привет",
        },
      ],
    };

    const error = await new DeepSeekProvider().complete(request).catch((value) => value);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("invalid_response");
    // The attempt still burned tokens, so it must reach the usage journal.
    expect(error.usage).toMatchObject({ promptTokens: 20, completionTokens: 3 });
  });

  it("returns structured audit issues without a second layer of JSON parsing", async () => {
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
                          issues: [
                            {
                              span: "Привет",
                              type: "unnatural_language",
                              severity: "medium",
                              reason: "Too casual",
                            },
                          ],
                        },
                        { id: "s0002", issues: "not an array" },
                      ],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 3 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const auditSegment = (id: string) => ({
      id,
      original: "Hello",
      initialTranslation: "Привет",
      editedTranslation: "Привет",
    });
    const response = await new DeepSeekProvider().complete({
      profile: { name: "critic", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
      mode: "audit",
      ...languages,
      segments: [auditSegment("document-1:0"), auditSegment("document-1:1")],
    });

    expect(response.segments[0].id).toBe("document-1:0");
    expect(response.segments[0].issues).toEqual([
      {
        span: "Привет",
        type: "unnatural_language",
        severity: "medium",
        reason: "Too casual",
      },
    ]);
    // One unusable segment must not cost the audit of its neighbour.
    expect(response.segments[1].id).toBe("document-1:1");
    expect(response.segments[1].issues).toEqual([]);
    expect(JSON.parse(response.segments[1].text).auditError).toBe("invalid_issues");
  });

  it("unwraps fenced structured content before validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '```json\n{"segments":[{"id":"s0001","text":"Привет"}]}\n```',
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
      mode: "translation",
      ...languages,
      segments: [{ id: "document-1:0", text: "Hello" }],
    });

    expect(response.segments).toEqual([{ id: "document-1:0", text: "Привет" }]);
  });

  it("reads Retry-After as seconds or a date and ignores what it cannot honour", () => {
    const now = Date.parse("2026-08-10T12:00:00Z");
    expect(retryAfterMs("2", now)).toBe(2000);
    expect(retryAfterMs("2026-08-10T12:00:30Z", now)).toBe(30_000);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs("0", now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
    // Past dates and pauses longer than the cap fall back to the caller's own backoff.
    expect(retryAfterMs("2026-08-10T11:59:00Z", now)).toBeUndefined();
    expect(retryAfterMs("3600", now)).toBeUndefined();
  });

  it("holds every concurrent request back for the Retry-After a 429 asked for", async () => {
    const calls: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push(Date.now());
        if (calls.length === 1)
          return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
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

    // One provider instance serves every worker, so the cooldown is shared.
    const provider = new DeepSeekProvider();
    const request = {
      profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
      mode: "translation" as const,
      ...languages,
      segments: [{ id: "document-1:0", text: "Hello" }],
    };

    await expect(provider.complete(request)).rejects.toMatchObject({ kind: "temporary" });
    // A second worker that never saw the 429 still waits it out.
    await provider.complete(request);

    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(900);
  });
});
