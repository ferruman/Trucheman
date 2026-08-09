import yazl from "yazl";
import { createWriteStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
async function files(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name),
      s = await stat(path);
    if (s.isDirectory()) out.push(...(await files(root, path)));
    else out.push(path);
  }
  return out;
}
export async function buildEpub(stagingRoot: string, outputPath: string): Promise<void> {
  const zip = new yazl.ZipFile(),
    all = await files(stagingRoot),
    mime = join(stagingRoot, "mimetype");
  if (!all.includes(mime)) throw new Error("EPUB mimetype is missing");
  zip.addBuffer(await readFile(mime), "mimetype", { compress: false });
  for (const path of all) {
    if (path === mime) continue;
    zip.addFile(path, relative(stagingRoot, path).split("\\").join("/"));
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outputPath);
    stream.on("error", reject);
    stream.on("close", resolve);
    zip.outputStream.pipe(stream);
    zip.end();
  });
}
