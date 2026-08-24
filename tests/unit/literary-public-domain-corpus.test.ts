import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { literaryEditorCorpusSchema } from "../../src/server/evals/literary-editor-eval.js";

describe("public-domain literary regression corpus", () => {
  it("is versioned, balanced, and carries an enforced acceptance floor", async () => {
    const corpus = literaryEditorCorpusSchema.parse(
      JSON.parse(await readFile("tests/fixtures/literary-public-domain-v1.json", "utf8")),
    );

    expect(corpus.version).toBe(1);
    expect(corpus.minPassRate).toBe(0.85);
    expect(corpus.cases).toHaveLength(20);
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(corpus.cases.length);
    expect(
      Object.fromEntries(
        ["alice-1865", "botchan-1906"].map((bookId) => [
          bookId,
          corpus.cases.filter((testCase) => testCase.bookId === bookId).length,
        ]),
      ),
    ).toEqual({ "alice-1865": 12, "botchan-1906": 8 });
    expect(corpus.cases.every((testCase) => testCase.forbidden.length > 0)).toBe(true);
  });
});
