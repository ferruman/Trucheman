import yazl from "yazl";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
export async function buildFixtureEpub(path: string) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compress: false });
  const files = {
    "META-INF/container.xml": `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
    "OEBPS/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>`,
    "OEBPS/chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en"><body><p>Hello <em>world</em>.</p></body></html>`,
    "OEBPS/toc.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">The call of Cthulhu</a></li></ol></nav></body></html>`,
    "OEBPS/toc.ncx": `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" xml:lang="en"><navMap><navPoint id="chapter"><navLabel><text>The CALL of CTHULHU</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>`,
  };
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path);
    stream.on("error", reject).on("close", resolve);
    zip.outputStream.pipe(stream);
    zip.end();
  });
  return path;
}
