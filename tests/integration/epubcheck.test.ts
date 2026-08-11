import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { epubCheckErrors, runOptionalEpubCheck } from "../../src/server/epub/epubcheck.js";
import { buildFixtureEpub } from "../fixtures/build-epubs.js";

const workspace = await mkdtemp(join(tmpdir(), "epubcheck-"));
afterAll(() => rm(workspace, { recursive: true, force: true }));

describe("optional EPUBCheck", () => {
  // Passes whether or not epubcheck is installed: absent means available: false, ok: true.
  it("surfaces the findings, which EPUBCheck writes to stderr", async () => {
    const path = join(workspace, "fixture.epub");
    await buildFixtureEpub(path);
    const result = await runOptionalEpubCheck(path);
    if (!result.available) {
      expect(result.ok).toBe(true);
      return;
    }
    // The fixture's container.xml omits the rootfile media type, so this is RSC-003.
    expect(result.ok).toBe(false);
    expect(epubCheckErrors(result.output).join("\n")).toContain("RSC-003");
  });

  it("refuses a path that is not named .epub, so the pipeline must check the built book", async () => {
    const path = join(workspace, "fixture.epub");
    await buildFixtureEpub(path);
    const disguised = join(workspace, "output.epub.1234.tmp");
    await copyFile(path, disguised);
    const result = await runOptionalEpubCheck(disguised);
    if (!result.available) return;

    // "Mode required for non-epub files" is not an ERROR line, so pointing the gate at the
    // temporary file reported nothing at all and looked like a clean pass for every run.
    expect(result.output).toContain("Mode required for non-epub files");
    expect(epubCheckErrors(result.output)).toEqual([]);
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
