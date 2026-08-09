import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  evaluateLiteraryOutput,
  literaryEditorCaseSchema,
  literaryEditorCorpusSchema,
} from "../../src/server/evals/literary-editor-eval.js";

const testCase = literaryEditorCaseSchema.parse({
  id: "example",
  genre: "dialogue",
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
  original: "That doesn't add up.",
  draft: "Это не складывается вверх.",
  forbidden: [{ pattern: "складывается вверх", label: "literal calque" }],
  requiredAny: [
    { pattern: "не сходится", label: "idiomatic option" },
    { pattern: "не вяжется", label: "idiomatic option" },
  ],
});

describe("literary editor evaluation", () => {
  it("passes a changed output that removes the calque and preserves the concept", () => {
    const result = evaluateLiteraryOutput(testCase, "Это не сходится.");

    expect(result.passed).toBe(true);
    expect(result.passedChecks).toBe(result.totalChecks);
  });

  it("reports individual regression checks without requiring one exact reference", () => {
    const result = evaluateLiteraryOutput(testCase, testCase.draft);

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "draft-changed", passed: false }),
        expect.objectContaining({ name: "forbidden:literal calque", passed: false }),
        expect.objectContaining({ name: "required-concept", passed: false }),
      ]),
    );
  });

  it("validates the committed multi-genre corpus", async () => {
    const corpus = literaryEditorCorpusSchema.parse(
      JSON.parse(await readFile("evals/literary-editor/cases.json", "utf8")),
    );

    expect(corpus.cases).toHaveLength(12);
    expect(new Set(corpus.cases.map((item) => item.genre)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(corpus.cases.map((item) => item.targetLanguage.tag)).size).toBeGreaterThan(1);
  });
});
