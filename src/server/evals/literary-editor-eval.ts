import { z } from "zod";

const languageSchema = z.object({ tag: z.string().min(2), name: z.string().min(1) }).strict();
const patternSchema = z
  .object({ pattern: z.string().min(1), flags: z.string().optional(), label: z.string().min(1) })
  .strict();

export const literaryEditorCaseSchema = z
  .object({
    id: z.string().min(1),
    genre: z.string().min(1),
    sourceLanguage: languageSchema,
    targetLanguage: languageSchema,
    original: z.string().min(1),
    draft: z.string().min(1),
    instructions: z.string().optional(),
    forbidden: z.array(patternSchema).default([]),
    requiredAny: z.array(patternSchema).default([]),
    requireChange: z.boolean().default(true),
    reviewNotes: z.string().default(""),
  })
  .strict();

export const literaryEditorCorpusSchema = z
  .object({
    version: z.number().int().positive(),
    description: z.string().min(1),
    cases: z.array(literaryEditorCaseSchema).min(1),
  })
  .strict();

export type LiteraryEditorCase = z.infer<typeof literaryEditorCaseSchema>;

export type AutomatedCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export function evaluateLiteraryOutput(testCase: LiteraryEditorCase, output: string) {
  const checks: AutomatedCheck[] = [
    {
      name: "non-empty",
      passed: output.trim().length > 0,
      detail: "The editor returned non-empty text",
    },
  ];

  if (testCase.requireChange) {
    checks.push({
      name: "draft-changed",
      passed: output.trim() !== testCase.draft.trim(),
      detail: "The intentionally flawed draft was changed",
    });
  }

  for (const forbidden of testCase.forbidden) {
    const matched = new RegExp(forbidden.pattern, forbidden.flags ?? "iu").test(output);
    checks.push({
      name: `forbidden:${forbidden.label}`,
      passed: !matched,
      detail: matched ? `Still contains ${forbidden.label}` : `Removed ${forbidden.label}`,
    });
  }

  if (testCase.requiredAny.length) {
    const matched = testCase.requiredAny.some((required) =>
      new RegExp(required.pattern, required.flags ?? "iu").test(output),
    );
    checks.push({
      name: "required-concept",
      passed: matched,
      detail: matched
        ? "Preserved at least one accepted expression of the key concept"
        : "Did not match any accepted expression of the key concept",
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    passedChecks: checks.filter((check) => check.passed).length,
    totalChecks: checks.length,
    checks,
  };
}

export const HUMAN_REVIEW_DIMENSIONS = [
  "semantic_fidelity",
  "native_language_naturalness",
  "lexical_and_idiomatic_naturalness",
  "voice_and_style_preservation",
] as const;
