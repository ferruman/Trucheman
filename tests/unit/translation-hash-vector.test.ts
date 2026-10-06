// The translated_from.hash vector from the Codicora spec (../vectors/translation-hash/, WORKSPACE.md §4.1),
// inlined so this repository tests alone. Imprimeor's tests carry the same vector: both must agree.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspace } from "../../src/server/workspace/codicora.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("translated_from.hash", () => {
  it("matches the spec vector: CRLF/CR → LF, BOM/NFD/trailing spaces kept, title falls back to the slug only when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "trucheman-hash-"));
    roots.push(root);
    const dir = join(root, "manuscript");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, "text"), { recursive: true });
    await writeFile(join(root, "codicora.yaml"), "spec: codicora/v1\nproject:\n  id: vector\n");
    await writeFile(
      join(dir, "manuscript.yaml"),
      'schema_version: 1\nlanguage: ru\nchapters:\n  - slug: ch-01\n    title: "Ключ"\n  - slug: ch-02\n  - slug: ch-03\n    title: ""\n    file: text/third.md\n',
    );
    await writeFile(
      join(dir, "chapters/ch-01.md"),
      "<!-- scene: s1 -->\r\nМарта нашла ключ.  \r\n\r\nКафе́ закрыто.\r\n",
    );
    await writeFile(join(dir, "chapters/ch-02.md"), "﻿Без названия.\rВторая строка.");
    await writeFile(join(dir, "text/third.md"), "<!-- scene: s1 -->\nПустое название.\n\n\n");
    const book = await readWorkspace(root, "manuscript");
    expect(book.sourceHash).toBe(
      "sha256:4498b81a64b77b9f876ecc90f99b4e4a42ad4ca26f5d12456d6c0ef295186f8b",
    );
  });
});
