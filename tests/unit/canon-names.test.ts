import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  withCanonNames,
  type ConsistencyDocument,
} from "../../src/server/jobs/consistency-service.js";
import { readCanonNames } from "../../src/server/workspace/codicora.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const doc = (...texts: string[]): ConsistencyDocument => ({
  id: "ch",
  sourceSegments: texts.map((text, i) => ({
    id: `ch:${i}`,
    text,
    sourceHash: "",
    locator: [],
    leading: "",
    trailing: "",
  })),
  editedSegments: [],
});

describe("withCanonNames", () => {
  const documents = [
    doc("Тамара позвонила Гвоздеву.", "— Тёма, ты где? — спросила она.", "Артём Гвоздев молчал."),
  ];
  const canon = [
    { name: "Артём Гвоздев", aliases: ["Гвоздев", "Тёма"], category: "person" },
    { name: "Сеймск", aliases: [], category: "place" },
  ];

  it("adds the names the book uses, inflected or not, and links aliases to the main name", () => {
    const out = withCanonNames([], documents, canon);
    expect(out.map((e) => [e.source, e.occurrences, e.same_as ?? null, e.category_hint])).toEqual([
      ["Артём Гвоздев", 1, null, "person"],
      ["Гвоздев", 2, "Артём Гвоздев", "person"], // «Гвоздеву» and «Гвоздев»
      ["Тёма", 1, "Артём Гвоздев", "person"],
    ]);
    expect(out.some((e) => e.source === "Сеймск")).toBe(false); // never in the text
  });

  it("annotates a name the extractor already found instead of adding it twice", () => {
    const found = [{ source: "Тамара", occurrences: 3, contexts: [] }];
    const out = withCanonNames(found, documents, [
      { name: "Тамара", aliases: [], category: "person" },
    ]);
    expect(out).toEqual([
      { source: "Тамара", occurrences: 3, contexts: [], category_hint: "person" },
    ]);
    expect(found[0]).not.toHaveProperty("category_hint"); // the input is not mutated
  });
});

describe("readCanonNames", () => {
  it("reads names and aliases from canon/exports/<book>.json through codicora.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "canon-"));
    roots.push(root);
    await writeFile(
      join(root, "codicora.yaml"),
      "project:\n  id: x\ncanon:\n  path: ./canon\n  book: books/eleven-days\n",
    );
    await mkdir(join(root, "canon", "exports"), { recursive: true });
    await writeFile(
      join(root, "canon", "exports", "eleven-days.json"),
      JSON.stringify({
        focus: {
          book: { id: "books/eleven-days", name: "Eleven Days" },
          entities: [
            {
              id: "characters/artyom",
              type: "character",
              name: "Артём Гвоздев",
              aliases: ["Тёма"],
            },
            { id: "locations/seymsk", type: "location", name: "Сеймск", aliases: [] },
          ],
          events: [{ id: "events/x", name: "Вера уходит" }],
        },
        world: {
          entities: [
            {
              id: "characters/artyom",
              type: "character",
              name: "Артём Гвоздев",
              aliases: ["Тёма"],
            },
          ],
        },
      }),
    );
    expect(await readCanonNames(root)).toEqual([
      { name: "Артём Гвоздев", aliases: ["Тёма"], category: "person" },
      { name: "Сеймск", aliases: [], category: "place" },
    ]);
  });

  it("is empty, not an error, for a project without a bible", async () => {
    const root = await mkdtemp(join(tmpdir(), "canon-"));
    roots.push(root);
    await writeFile(join(root, "codicora.yaml"), "project:\n  id: x\n");
    expect(await readCanonNames(root)).toEqual([]);
  });
});
