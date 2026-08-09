import { z } from "zod";
import type {
  LanguageModelProvider,
  ProviderAuditInputSegment,
  ProviderLanguage,
  ProviderProfile,
  ProviderRepairInputSegment,
  ProviderSegment,
} from "../providers/provider.js";
import { processBatch } from "./translation-service.js";

export const QUALITY_ISSUE_TYPES = [
  "semantic_error",
  "source_language_interference",
  "unnatural_language",
  "context_error",
  "glossary_inconsistency",
  "editor_regression",
] as const;

const qualityIssueSchema = z
  .object({
    span: z.string().min(1).max(2_000),
    type: z.enum(QUALITY_ISSUE_TYPES),
    severity: z.enum(["medium", "high"]),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

const auditResultSchema = z.object({ issues: z.array(qualityIssueSchema).max(12) }).strict();

export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type QualityFinding = { id: string; issues: QualityIssue[]; rejectedIssues: number };

export function buildQualityAuditSegments(
  original: ProviderSegment[],
  initialTranslation: ProviderSegment[],
  editedTranslation: ProviderSegment[],
): ProviderAuditInputSegment[] {
  const initialById = new Map(initialTranslation.map((segment) => [segment.id, segment.text]));
  const editedById = new Map(editedTranslation.map((segment) => [segment.id, segment.text]));
  return original.map((segment) => ({
    id: segment.id,
    original: segment.text,
    initialTranslation: initialById.get(segment.id) ?? "",
    editedTranslation: editedById.get(segment.id) ?? "",
  }));
}

export function parseQualityFindings(
  inputs: ProviderAuditInputSegment[],
  outputs: ProviderSegment[],
): QualityFinding[] {
  const inputById = new Map(inputs.map((segment) => [segment.id, segment]));
  return outputs.map((segment) => {
    let value: unknown;
    try {
      value = JSON.parse(segment.text);
    } catch {
      throw new Error(`Quality audit returned malformed JSON for ${segment.id}`);
    }
    const parsed = auditResultSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Quality audit returned invalid issues for ${segment.id}`);
    }
    const edited = inputById.get(segment.id)?.editedTranslation ?? "";
    const issues = parsed.data.issues.filter((issue) => edited.includes(issue.span));
    return {
      id: segment.id,
      issues,
      rejectedIssues: parsed.data.issues.length - issues.length,
    };
  });
}

export function buildRepairSegments(
  inputs: ProviderAuditInputSegment[],
  findings: QualityFinding[],
): ProviderRepairInputSegment[] {
  const issuesById = new Map(
    findings
      .filter((finding) => finding.issues.length)
      .map((finding) => [finding.id, finding.issues]),
  );
  return inputs.flatMap((segment, index) => {
    const issues = issuesById.get(segment.id);
    return issues
      ? [
          {
            ...segment,
            contextBefore: inputs[index - 1]?.editedTranslation,
            contextAfter: inputs[index + 1]?.editedTranslation,
            issues,
          },
        ]
      : [];
  });
}

export function applySelectiveRepairs(
  edited: ProviderSegment[],
  repairs: ProviderSegment[],
): ProviderSegment[] {
  const repairedById = new Map(repairs.map((segment) => [segment.id, segment.text]));
  return edited.map((segment) => ({
    ...segment,
    text: repairedById.get(segment.id) ?? segment.text,
  }));
}

export async function auditBatch(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  segments: ProviderAuditInputSegment[],
  languages: { sourceLanguage: ProviderLanguage; targetLanguage: ProviderLanguage },
  instructions = "",
  glossary: unknown[] = [],
  signal?: AbortSignal,
) {
  const completed = await processBatch(
    provider,
    profile,
    "audit",
    segments,
    languages,
    instructions,
    glossary,
    3,
    signal,
  );
  return { ...completed, findings: parseQualityFindings(segments, completed.result.segments) };
}

export async function repairBatch(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  segments: ProviderRepairInputSegment[],
  languages: { sourceLanguage: ProviderLanguage; targetLanguage: ProviderLanguage },
  instructions = "",
  glossary: unknown[] = [],
  signal?: AbortSignal,
) {
  return processBatch(
    provider,
    profile,
    "repair",
    segments,
    languages,
    instructions,
    glossary,
    3,
    signal,
  );
}
