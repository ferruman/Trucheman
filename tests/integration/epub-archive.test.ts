import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateArchiveEntries } from "../../src/server/epub/archive-policy.js";
import { extractEpub } from "../../src/server/epub/extract.js";
import { buildFixtureEpub } from "../fixtures/build-epubs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EPUB archive safety", () => {
  it.each(["../outside", "/absolute", "C:/windows", "nested/../../outside", "nested\\file"])(
    "rejects an archive entry outside the extraction root: %s",
    (fileName) =>
      expect(() =>
        validateArchiveEntries([{ fileName, compressedSize: 1, uncompressedSize: 1 }]),
      ).toThrow(),
  );

  it("rejects encrypted entries before extraction", () =>
    expect(() =>
      validateArchiveEntries([
        { fileName: "book", compressedSize: 1, uncompressedSize: 1, encrypted: true },
      ]),
    ).toThrow());

  it("extracts an otherwise valid EPUB with one trailing NUL without modifying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "epub-trailing-null-"));
    roots.push(root);
    const source = await buildFixtureEpub(join(root, "source.epub"));
    await appendFile(source, Buffer.from([0]));
    const sourceSize = (await stat(source)).size;

    await expect(extractEpub(source, join(root, "extracted"))).resolves.toContain("mimetype");
    expect(await readFile(join(root, "extracted", "mimetype"), "utf8")).toBe(
      "application/epub+zip",
    );
    expect((await stat(source)).size).toBe(sourceSize);
  });

  it("does not ignore arbitrary bytes after the ZIP footer", async () => {
    const root = await mkdtemp(join(tmpdir(), "epub-trailing-byte-"));
    roots.push(root);
    const source = await buildFixtureEpub(join(root, "source.epub"));
    await appendFile(source, "X");

    await expect(extractEpub(source, join(root, "extracted"))).rejects.toThrow(
      /Invalid comment length/,
    );
  });
});
