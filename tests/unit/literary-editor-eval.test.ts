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

  it("rejects the false positives found in the literary-v3.1 baseline", async () => {
    const corpus = literaryEditorCorpusSchema.parse(
      JSON.parse(await readFile("evals/literary-editor/cases.json", "utf8")),
    );
    const outputs = new Map([
      [
        "lovecraft-correlate-contents",
        "Самое милосердное в мире — неспособность человеческого разума связать всё своё содержание.",
      ],
      [
        "lovecraft-piecing-knowledge",
        "Сопоставление разрозненных знаний откроет такие устрашающие горизонты реальности.",
      ],
      [
        "lovecraft-accidental-piecing",
        "Этот проблеск возник из случайного сопоставления разрозненных вещей.",
      ],
      ["lovecraft-put-together", "Надеюсь, никому другому не удастся завершить эту сборку."],
      ["modern-dialogue-add-up", "Концы с концами не сходятся, и ты это знаешь."],
    ]);

    for (const [id, output] of outputs) {
      const corpusCase = corpus.cases.find((item) => item.id === id);
      expect(corpusCase, `missing corpus case ${id}`).toBeDefined();
      const evaluation = evaluateLiteraryOutput(corpusCase!, output);
      expect(evaluation.passed, id).toBe(false);
      expect(
        evaluation.checks.some((check) => check.name.startsWith("forbidden:") && !check.passed),
        id,
      ).toBe(true);
    }
  });

  it("accepts the natural correlate-contents reformulation found by V4 Pro", async () => {
    const corpus = literaryEditorCorpusSchema.parse(
      JSON.parse(await readFile("evals/literary-editor/cases.json", "utf8")),
    );
    const corpusCase = corpus.cases.find((item) => item.id === "lovecraft-correlate-contents");

    expect(corpusCase).toBeDefined();
    expect(
      evaluateLiteraryOutput(
        corpusCase!,
        "Самое милосердное в мире — неспособность человеческого разума связать воедино всё, что в нём заключено.",
      ).passed,
    ).toBe(true);
  });

  it("accepts an idiomatic put-together reformulation", async () => {
    const corpus = literaryEditorCorpusSchema.parse(
      JSON.parse(await readFile("evals/literary-editor/cases.json", "utf8")),
    );
    const corpusCase = corpus.cases.find((item) => item.id === "lovecraft-put-together");

    expect(corpusCase).toBeDefined();
    expect(
      evaluateLiteraryOutput(
        corpusCase!,
        "Я надеюсь, что никому другому не удастся собрать это воедино.",
      ).passed,
    ).toBe(true);
  });

  it("accepts an idiomatic finite-clause piecing-together reformulation", async () => {
    const corpus = literaryEditorCorpusSchema.parse(
      JSON.parse(await readFile("evals/literary-editor/cases.json", "utf8")),
    );
    const corpusCase = corpus.cases.find((item) => item.id === "lovecraft-piecing-knowledge");

    expect(corpusCase).toBeDefined();
    expect(
      evaluateLiteraryOutput(
        corpusCase!,
        "Когда разрозненные знания будут сведены воедино, перед нами откроются ужасающие картины действительности.",
      ).passed,
    ).toBe(true);
  });
});
