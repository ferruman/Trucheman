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
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml"><body><a id="chapter" name="chapter"></a><p>[Bad] File (v1).xhtml remains visible</p><p class="outline">Before <h1>Outline</h1><ul><li>Chapter</li></ul> after</p><br clear="both"/><img border="0" v:shapes="shape1" src="image.jpg"/></body></html>`,
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
      restructuredParagraphs: 1,
      declaredScripted: 0,
      alignedNcxIdentifier: 0,
      droppedDanglingRefines: 0,
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
    expect(xhtml).toContain('<p class="outline">Before </p><h1>Outline</h1>');
    expect(xhtml).toContain('</ul><p class="outline"> after</p>');
    const css = await readFile(join(repaired, "OEBPS", "Text", "styles.css"), "utf8");
    expect(css).toContain('url("cover_image.jpg")');
    expect(css).toContain('content: "cover image.jpg remains visible"');
  });

  it("makes the package describe its own files: scripts, NCX identity, dead refines", async () => {
    // A reader-produced EPUB can load JavaScript the manifest never declares. The NCX may
    // announce the identifier of the tool that rebuilt it, while metadata refines a creator id
    // that a later tool renamed away.
    const root = await mkdtemp(join(tmpdir(), "epub-declare-"));
    roots.push(root);
    const source = join(root, "source");
    const repaired = join(root, "repaired");
    await mkdir(join(source, "META-INF"), { recursive: true });
    await mkdir(join(source, "item", "xhtml"), { recursive: true });
    await writeFile(
      join(source, "META-INF", "container.xml"),
      `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="item/standard.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    );
    await writeFile(
      join(source, "item", "standard.opf"),
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:real</dc:identifier><dc:creator id="id-1">Author</dc:creator><meta refines="#creator01" property="role">aut</meta><meta refines="#id-1" property="role">aut</meta></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="p1" href="xhtml/p-001.xhtml" media-type="application/xhtml+xml"/><item id="p2" href="xhtml/p-002.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="p3" href="xhtml/p-003.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="p1"/></spine></package>`,
    );
    await writeFile(
      join(source, "item", "toc.ncx"),
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><head><meta name="dtb:uid" content="urn:uuid:stale"/></head><navMap/></ncx>`,
    );
    const scripted = `<html xmlns="http://www.w3.org/1999/xhtml"><head><script type="text/javascript" src="js/kobo.js"/></head><body><p>Text</p></body></html>`;
    await writeFile(join(source, "item", "xhtml", "p-001.xhtml"), scripted);
    await writeFile(join(source, "item", "xhtml", "p-002.xhtml"), scripted);
    await writeFile(
      join(source, "item", "xhtml", "p-003.xhtml"),
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>No script here</p></body></html>`,
    );

    const summary = await createRepairedEpubWorkspace(source, repaired);

    expect(summary).toMatchObject({
      declaredScripted: 2,
      alignedNcxIdentifier: 1,
      droppedDanglingRefines: 1,
    });
    const opf = await readFile(join(repaired, "item", "standard.opf"), "utf8");
    expect(opf).toContain(
      'href="xhtml/p-001.xhtml" media-type="application/xhtml+xml" properties="scripted"',
    );
    // An existing property is kept rather than replaced.
    expect(opf).toMatch(/p-002\.xhtml[^>]*properties="nav scripted"/);
    // A page without a script is left alone, and the live refines survives.
    expect(opf).toMatch(/p-003\.xhtml(?![^>]*properties)/);
    expect(opf).not.toContain("creator01");
    expect(opf).toContain('refines="#id-1"');
    expect(await readFile(join(repaired, "item", "toc.ncx"), "utf8")).toContain(
      'content="urn:uuid:real"',
    );
  });
});
