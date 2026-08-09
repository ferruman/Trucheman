import { describe, expect, it } from "vitest";
import { runOptionalEpubCheck } from "../../src/server/epub/epubcheck.js";
describe("optional EPUBCheck", () =>
  it("does not block when the tool is absent", async () => {
    const result = await runOptionalEpubCheck("missing.epub");
    expect(result.available).toBe(false);
    expect(result.ok).toBe(true);
  }));
