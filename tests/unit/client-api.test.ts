import { afterEach, describe, expect, it, vi } from "vitest";
import { api, jobActions, uploadSource } from "../../src/client/app/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("client API", () => {
  it("preserves caller headers and adds JSON content type for a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "job-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.create({ title: "Book" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("surfaces RFC problem details from upload failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "The EPUB is invalid" }), {
          status: 400,
          headers: { "content-type": "application/problem+json" },
        }),
      ),
    );

    await expect(uploadSource("job-1", new File(["book"], "book.epub"))).rejects.toThrow(
      "The EPUB is invalid",
    );
  });

  it("sends invalidation scopes in the conventional API shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await jobActions.invalidate("job-1", ["translations", "edits", "output"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jobs/job-1/invalidate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scopes: ["translations", "edits", "output"] }),
      }),
    );
  });

  it("deletes exactly the requested job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await jobActions.remove("job-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jobs/job-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
