import { describe, expect, it } from "vitest";
import {
  evaluateLiteraryOutput,
  literaryEditorCaseSchema,
} from "../../src/server/evals/literary-editor-eval.js";

const testCase = literaryEditorCaseSchema.parse({
  id: "synthetic-example",
  genre: "synthetic-test",
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
  original: "Synthetic source text.",
  draft: "Синтетический черновик с ошибкой.",
  forbidden: [{ pattern: "с ошибкой", label: "synthetic defect" }],
  requiredAny: [{ pattern: "исправлен", label: "synthetic correction" }],
});

describe("literary editor evaluation", () => {
  it("passes a changed output that removes a defect and preserves the required concept", () => {
    const result = evaluateLiteraryOutput(testCase, "Исправленный синтетический текст.");

    expect(result.passed).toBe(true);
    expect(result.passedChecks).toBe(result.totalChecks);
  });

  it("reports individual regression checks without requiring one exact reference", () => {
    const result = evaluateLiteraryOutput(testCase, testCase.draft);

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "draft-changed", passed: false }),
        expect.objectContaining({ name: "forbidden:synthetic defect", passed: false }),
        expect.objectContaining({ name: "required-concept", passed: false }),
      ]),
    );
  });
});
