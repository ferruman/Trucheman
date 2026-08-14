import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepairedEpubWorkspace } from "../../src/server/epub/repair.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("EPUB structural repair", () => {
  it("renames unsafe entries, updates references, IDs, and legacy XHTML attributes", async () => {
    const root = await mkdtemp(join(tmpdir(), "epub-repair-"));
    roots.push(root);
    const source = join(root, "source");
    const repaired = join(root, "repaired");
    await mkdir(join(source, "OEBPS", "Text"), { recursive: true });
    await writeFile(
      join(source, "OEBPS", "content.opf"),
      `<package version="2.0" xml:lang="ru"><manifest><item id="chapter" href="Text/[Bad] File (v1).xhtml"/></manifest></package>`,
    );
    await writeFile(
      join(source, "OEBPS", "toc.ncx"),
      `<ncx><navMap><navPoint id="1bad:id"><content src="Text/%5bBad%5d%20File%20%28v1%29.xhtml#1bad:id"/></navPoint></navMap></ncx>`,
    );
    await writeFile(
      join(source, "OEBPS", "Text", "[Bad] File (v1).xhtml"),
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml"><body><a id="chapter" name="chapter"></a><p>[Bad] File (v1).xhtml remains visible</p><br clear="both"/><img border="0" v:shapes="shape1" src="image.jpg"/></body></html>`,
    );
    await writeFile(
      join(source, "OEBPS", "Text", "styles.css"),
      `.cover { background: url("cover image.jpg"); content: "cover image.jpg remains visible"; }`,
    );
    await writeFile(join(source, "OEBPS", "Text", "cover image.jpg"), "image");

    const summary = await createRepairedEpubWorkspace(source, repaired);

    expect(summary).toEqual({
      renamedEntries: 2,
      updatedReferences: 4,
      rewrittenIds: 1,
      removedLegacyAttributes: 5,
      convertedAnchors: 1,
    });
    await expect(
      access(join(repaired, "OEBPS", "Text", "_Bad_File_v1_.xhtml")),
    ).resolves.toBeUndefined();
    const opf = await readFile(join(repaired, "OEBPS", "content.opf"), "utf8");
    const ncx = await readFile(join(repaired, "OEBPS", "toc.ncx"), "utf8");
    const xhtml = await readFile(join(repaired, "OEBPS", "Text", "_Bad_File_v1_.xhtml"), "utf8");
    expect(opf).toContain('href="Text/_Bad_File_v1_.xhtml"');
    expect(opf).not.toContain("xml:lang");
    expect(ncx).toContain('id="id-1bad-id"');
    expect(ncx).toContain('src="Text/_Bad_File_v1_.xhtml#id-1bad-id"');
    expect(xhtml).not.toMatch(/\s(?:clear|border|name|v:shapes)=/);
    expect(xhtml).toContain('<div id="chapter"');
    expect(xhtml).toContain("[Bad] File (v1).xhtml remains visible");
    expect(xhtml).toContain("clear: both");
    expect(xhtml).toContain("border-width: 0px");
    const css = await readFile(join(repaired, "OEBPS", "Text", "styles.css"), "utf8");
    expect(css).toContain('url("cover_image.jpg")');
    expect(css).toContain('content: "cover image.jpg remains visible"');
  });
});
