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

  it("shows the text around the point where malformed output stopped parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    // A missing comma between two array elements: the size and the finish
                    // reason say the model was not cut off, only the text says why.
                    content: '{"segments":[{"id":"s0001","text":"Дом Тайн"} {"id":"s0002"}]}',
                  },
                  finish_reason: "stop",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      new DeepSeekProvider().complete({
        profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
        mode: "translation",
        ...languages,
        segments: [{ id: "document-1:0", text: "House of Secrets" }],
      }),
    ).rejects.toThrow(/near: .*"Дом Тайн"} \{"id":"s0002"/);
  });

  it("counts the parse position from the text that was parsed, not the whole answer", async () => {
    // The parser retries inside the fence, so the reported position is an offset into the
    // fenced text; measuring it from the raw answer points the window at innocent bytes.
    const preamble = "Here is the JSON you asked for, carefully checked:\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: `${preamble}\`\`\`json\n{"segments":[{"id":"s0001","text":"Дом Тайн"} {"id":"s0002"}]}\n\`\`\``,
                  },
                  finish_reason: "stop",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const error = await new DeepSeekProvider()
      .complete({
        profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
        mode: "translation",
        ...languages,
        segments: [{ id: "document-1:0", text: "House of Secrets" }],
      })
      .catch((value) => value);
    expect(error.message).toContain('near: {"segments":[{"id":"s0001","text":"Дом Тайн"} {"id"');
    expect(error.message).not.toContain(preamble.trim());
  });

  it("accepts a consistency answer with no segments wrapper around it", async () => {
    const entries = { entries: [{ source: "House of Secrets", target: "Дом Тайн" }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify(entries),
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
      profile: { name: "consistency", endpoint: "https://provider.test", model: "x", apiKey: "s" },
      mode: "consistency",
      ...languages,
      segments: [{ id: "entity-registry-1", text: '{"task":"entity_registry"}' }],
    });

    // The caller parses `text`, so the shape it gets back is the same either way — only the
    // escaping the model had to do by hand is gone.
    expect(JSON.parse(response.segments[0].text)).toEqual(entries);
  });

  it("still accepts a consistency answer the model wrapped in segments", async () => {
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
                      segments: [{ id: "s0001", text: { entries: [] } }],
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
      profile: { name: "consistency", endpoint: "https://provider.test", model: "x", apiKey: "s" },
      mode: "consistency",
      ...languages,
      segments: [{ id: "entity-registry-1", text: '{"task":"entity_registry"}' }],
    });

    expect(response.segments[0].id).toBe("entity-registry-1");
    expect(JSON.parse(response.segments[0].text)).toEqual({ entries: [] });
  });

  it("still accepts a consistency answer the model stringified itself", async () => {
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
                      segments: [{ id: "s0001", text: '{"decisions":[]}' }],
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
      profile: { name: "consistency", endpoint: "https://provider.test", model: "x", apiKey: "s" },
      mode: "consistency",
      ...languages,
      segments: [{ id: "resolve-1", text: '{"task":"resolve_conflicts"}' }],
    });

    expect(JSON.parse(response.segments[0].text)).toEqual({ decisions: [] });
  });

  it("rejects a shifted translation whose IDs still line up", async () => {
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
                        // The model answered both halves of the split sentence here, then
                        // moved every remaining answer up one and repeated the last.
                        { id: "s0001", text: "б".repeat(190) },
                        { id: "s0002", text: "в".repeat(300) },
                        { id: "s0003", text: "в".repeat(300) },
                      ],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 40, completion_tokens: 9 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const error = await new DeepSeekProvider()
      .complete({
        profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
        mode: "translation",
        ...languages,
        segments: [
          { id: "document-1:0", text: "a".repeat(120) },
          { id: "document-1:1", text: "b".repeat(60) },
          { id: "document-1:2", text: "c".repeat(300) },
        ],
      })
      .catch((value) => value);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toContain("runs into the next segment at document-1:1");
    expect(error.usage).toMatchObject({ promptTokens: 40, completionTokens: 9 });
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

  it("names the transport fault instead of reporting every drop identically", async () => {
    // What Node throws when the connection dies mid-run: one generic message, the real
    // fault in `cause`. A whole book's failures read "Provider request failed" without it.
    const dropped = new TypeError("fetch failed");
    (dropped as { cause?: unknown }).cause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw dropped;
      }),
    );

    await expect(
      new DeepSeekProvider().complete({
        profile: { name: "x", endpoint: "https://provider.test", model: "x", apiKey: "secret" },
        mode: "translation",
        ...languages,
        segments: [{ id: "document-1:0", text: "Hello" }],
      }),
    ).rejects.toMatchObject({
      kind: "temporary",
      message: "Provider request failed (ECONNRESET)",
    });
  });
});
