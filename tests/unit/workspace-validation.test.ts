import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import {
  readWorkspace,
  exportLocalization,
  chapterXhtml,
} from "../../src/server/workspace/codicora.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-validation-"));
  roots.push(root);
  await mkdir(join(root, "manuscript", "chapters"), { recursive: true });
  await writeFile(
    join(root, "codicora.yaml"),
    "project:\n  id: demo\nlocalization:\n  path: ./translated\n",
  );
  await writeFile(
    join(root, "manuscript", "manuscript.yaml"),
    "schema_version: 1\nlanguage: en\nchapters:\n  - slug: one\n    title: One\n",
  );
  await writeFile(join(root, "manuscript", "chapters", "one.md"), "Original.");
  return root;
}
it("rejects duplicate chapter slugs before producing an EPUB that overwrites a chapter", async () => {
  const root = await fixture();
  await writeFile(join(root, "manuscript", "chapters", "two.md"), "Second original.");
  await writeFile(
    join(root, "manuscript", "manuscript.yaml"),
    "schema_version: 1\nlanguage: en\nchapters:\n  - slug: one\n    file: chapters/one.md\n  - slug: one\n    file: chapters/two.md\n",
  );
  await expect(readWorkspace(root)).rejects.toMatchObject({
    code: "workspace_invalid",
    message: expect.stringContaining("duplicate chapter slug one"),
  });
});
it("honors localization.path even when the original chapter has disappeared", async () => {
  const root = await fixture();
  const book = await readWorkspace(root);
  const staging = join(root, "staging");
  await mkdir(join(staging, "OEBPS", "text"), { recursive: true });
  await writeFile(join(staging, "OEBPS", "content.opf"), '<item href="text/one.xhtml"/>');
  await writeFile(
    join(staging, "OEBPS", "text", "one.xhtml"),
    chapterXhtml({ slug: "one", title: "Первая", text: "Перевод." }, "ru"),
  );
  await rm(join(root, "manuscript", "chapters", "one.md"));
  const link = { path: root, text: book.text, sourceHash: book.sourceHash };
  const result = await exportLocalization(staging, link, "ru");
  expect(result.dir).toBe(join(root, "translated", "ru"));
  expect(await readFile(join(result.dir, "chapters", "one.md"), "utf8")).toContain("Перевод.");
  expect(
    parse(await readFile(join(result.dir, "manuscript.yaml"), "utf8")).translated_from.current,
  ).toBe("unknown");
  await expect(access(join(root, "localization"))).rejects.toThrow();
  await rm(join(root, "codicora.yaml"));
  await expect(exportLocalization(staging, link, "ru")).rejects.toMatchObject({
    code: "workspace_invalid",
  });
  expect(await readFile(join(result.dir, "chapters", "one.md"), "utf8")).toContain("Перевод.");
});
