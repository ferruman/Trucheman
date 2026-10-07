import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWorkspace } from "../../src/server/workspace/codicora.js";

// MANUSCRIPT.md as data (../../vectors/manuscript/): Trucheman reads every case's chapters, titles and files, or stops
// with the case's code. It translates whole chapters, so scene ids are not its business here.
const vector = fileURLToPath(new URL("../../../vectors/manuscript/", import.meta.url));

describe.skipIf(!existsSync(join(vector, "cases.json")))("manuscript vector", () => {
  it("every case reads or stops as MANUSCRIPT.md says", async () => {
    const { cases } = JSON.parse(await readFile(join(vector, "cases.json"), "utf8")) as {
      cases: Array<{ name: string; error?: string; expect?: { language: string; chapters: Array<{ slug: string; title: string; file: string }> } }>;
    };
    for (const c of cases) {
      const ws = await mkdtemp(join(tmpdir(), "truch-msv-"));
      await cp(join(vector, c.name, "manuscript"), join(ws, "manuscript"), { recursive: true });
      await writeFile(join(ws, "codicora.yaml"), "spec: codicora/v1\nproject: { id: v }\n");
      if (c.error) {
        await expect(readWorkspace(ws, "manuscript"), c.name).rejects.toThrow(new RegExp(`^${c.error}:`));
        continue;
      }
      const book = await readWorkspace(ws, "manuscript");
      expect({ language: book.language, chapters: book.chapters.map((ch) => ({ slug: ch.slug, title: ch.title, file: ch.file })) }, c.name).toEqual({
        language: c.expect!.language,
        chapters: c.expect!.chapters.map(({ slug, title, file }) => ({ slug, title, file })),
      });
    }
  });
});
