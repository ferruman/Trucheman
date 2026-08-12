import { z } from "zod";
import type {
  LanguageModelProvider,
  ProviderAuditInputSegment,
  ProviderLanguage,
  ProviderProfile,
  ProviderRepairInputSegment,
  ProviderSegment,
} from "../providers/provider.js";
import {
  QUALITY_ISSUE_TYPES,
  qualityIssueSchema,
  type AuditError,
  type QualityIssue,
} from "../providers/audit-contract.js";
import { processBatch } from "./translation-service.js";

export { QUALITY_ISSUE_TYPES };
export type { QualityIssue };

const auditResultSchema = z
  .object({
    issues: z.array(qualityIssueSchema).max(12),
    auditError: z.string().optional(),
  })
  .strict();

export type QualityFinding = {
  id: string;
  issues: QualityIssue[];
  rejectedIssues: number;
  auditError?: AuditError;
};

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
    // Structured `issues` is authoritative; `text` is only read for journals written
    // before the critic gained its own response schema.
    let value: unknown = segment.issues ? { issues: segment.issues } : undefined;
    if (value === undefined) {
      try {
        value = JSON.parse(segment.text);
      } catch {
        return {
          id: segment.id,
          issues: [],
          rejectedIssues: 0,
          auditError: "malformed_json" as const,
        };
      }
    }
    const parsed = auditResultSchema.safeParse(value);
    if (!parsed.success) {
      return {
        id: segment.id,
        issues: [],
        rejectedIssues: 0,
        auditError: "invalid_issues" as const,
      };
    }
    if (parsed.data.auditError) {
      return {
        id: segment.id,
        issues: [],
        rejectedIssues: 0,
        auditError:
          parsed.data.auditError === "malformed_json" ? "malformed_json" : "invalid_issues",
      };
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

const wordPattern = /[\p{L}\p{M}]{4,}/gu;

function commonPrefixLength(left: string, right: string) {
  let index = 0;
  while (index < Math.min(left.length, right.length) && left[index] === right[index]) index++;
  return index;
}

/**
 * Two adjacent words sharing a long stem are the signature of the production regression
 * where repairing a fragmented heading produced "В пустыне пустыня".
 */
function adjacentStemRepetitions(text: string): number {
  const words = [...text.toLocaleLowerCase().matchAll(wordPattern)].map((match) => ({
    value: match[0],
    index: match.index ?? 0,
  }));
  let count = 0;
  for (let index = 1; index < words.length; index++) {
    const previous = words[index - 1];
    const current = words[index];
    const between = text.slice(previous.index + previous.value.length, current.index);
    if (/[\p{L}\p{N}]/u.test(between)) continue;
    if (commonPrefixLength(previous.value, current.value) >= 4) count++;
  }
  return count;
}

function quoteImbalance(text: string) {
  return (text.match(/«/gu)?.length ?? 0) - (text.match(/»/gu)?.length ?? 0);
}

function latinRuns(text: string) {
  return text.match(/[A-Za-z]{3,}/gu)?.length ?? 0;
}

export type RepairRejection = { id: string; reason: string };

/**
 * Deterministic gate in front of every model repair. A repair may only replace the
 * segment it was asked about, and only when it does not introduce an empty segment,
 * duplicated fragment, source-language residue, or quote imbalance. Anything else keeps
 * the edited text, which is already known to be acceptable.
 */
export function reviewRepair(
  edited: string,
  repaired: string,
  original = edited,
): string | undefined {
  if (!repaired.trim()) return "empty repair";
  if (repaired === edited) return undefined;
  // A repair rewords; it does not turn a heading into a sentence. Measured against the source
  // as well as the edit: when the defect *is* a truncated block, the only correct repair is
  // longer than what it replaces, and reading the edit alone rejected exactly those.
  if (repaired.length > Math.max(edited.length, original.length) * 2 + 20)
    return "repair changes the block structure";
  const introduced = adjacentStemRepetitions(repaired) - adjacentStemRepetitions(edited);
  if (introduced > 0) return "repair duplicates an adjacent fragment";
  if (quoteImbalance(edited) === 0 && quoteImbalance(repaired) !== 0)
    return "repair unbalances guillemets";
  if (latinRuns(repaired) > latinRuns(edited)) return "repair introduces source-language residue";
  return undefined;
}

export function applySelectiveRepairs(
  edited: ProviderSegment[],
  repairs: ProviderSegment[],
  inputs: ProviderRepairInputSegment[] = [],
): { segments: ProviderSegment[]; rejected: RepairRejection[] } {
  const repairedById = new Map(repairs.map((segment) => [segment.id, segment.text]));
  const originalById = new Map(inputs.map((segment) => [segment.id, segment.original]));
  const rejected: RepairRejection[] = [];
  const segments = edited.map((segment) => {
    const repaired = repairedById.get(segment.id);
    if (repaired === undefined) return segment;
    const reason = reviewRepair(segment.text, repaired, originalById.get(segment.id));
    if (reason) {
      rejected.push({ id: segment.id, reason });
      return segment;
    }
    return { ...segment, text: repaired };
  });
  return { segments, rejected };
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
  try {
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
  } catch (error) {
    if (signal?.aborted) throw error;
    // The critic is advisory. After its retries are exhausted, record the failure and let
    // translation and editing stand rather than failing the whole book.
    const quarantined = segments.map((segment) => ({
      id: segment.id,
      text: JSON.stringify({ issues: [], auditError: "malformed_json" }),
      issues: [],
    }));
    return {
      result: { segments: quarantined, finishReason: "stop" },
      warnings: [`Audit unavailable: ${error instanceof Error ? error.message : "unknown error"}`],
      attempts: 0,
      findings: segments.map((segment) => ({
        id: segment.id,
        issues: [],
        rejectedIssues: 0,
        auditError: "malformed_json" as const,
      })),
    };
  }
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
