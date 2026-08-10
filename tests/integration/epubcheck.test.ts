import { describe, expect, it } from "vitest";
import { epubCheckErrors, runOptionalEpubCheck } from "../../src/server/epub/epubcheck.js";
describe("optional EPUBCheck", () => {
  it("does not block when the tool is absent", async () => {
    const result = await runOptionalEpubCheck("missing.epub");
    expect(result.available).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("reports only errors, capped", () => {
    const output = [
      "Validating using EPUB version 3.3 rules.",
      "WARNING(OPF-003): output.epub/OEBPS/content.opf(2,1): item not in spine",
      "ERROR(RSC-005): output.epub/OEBPS/ch1.xhtml(4,7): attribute lang not allowed",
      "FATAL(PKG-008): output.epub: unable to read file",
    ].join("\n");
    expect(epubCheckErrors(output)).toEqual([
      "ERROR(RSC-005): output.epub/OEBPS/ch1.xhtml(4,7): attribute lang not allowed",
      "FATAL(PKG-008): output.epub: unable to read file",
    ]);

    const many = Array.from({ length: 25 }, (_, index) => `ERROR(RSC-005): problem ${index}`);
    const capped = epubCheckErrors(many.join("\n"));
    expect(capped).toHaveLength(21);
    expect(capped.at(-1)).toContain("5 further problems");
  });
});
