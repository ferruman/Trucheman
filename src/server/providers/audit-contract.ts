import { z } from "zod";

export const QUALITY_ISSUE_TYPES = [
  "semantic_error",
  "source_language_interference",
  "unnatural_language",
  "context_error",
  "glossary_inconsistency",
  "editor_regression",
] as const;

export const qualityIssueSchema = z
  .object({
    span: z.string().min(1).max(2_000),
    type: z.enum(QUALITY_ISSUE_TYPES),
    severity: z.enum(["medium", "high"]),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

/**
 * The critic answers with issues as real JSON, not a JSON document escaped inside the
 * `text` string. The nested encoding cost a production run 171 unparseable segments.
 */
export const qualityAuditSegmentSchema = z.object({
  id: z.string().min(1),
  issues: z.array(qualityIssueSchema).max(12),
});

export const qualityAuditResponseSchema = z.object({
  segments: z.array(qualityAuditSegmentSchema),
});

export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type QualityAuditSegment = z.infer<typeof qualityAuditSegmentSchema>;
export type QualityAuditResponse = z.infer<typeof qualityAuditResponseSchema>;
export type AuditError = "malformed_json" | "invalid_issues";

export type ParsedAuditSegment = { id: string; issues: QualityIssue[]; auditError?: AuditError };

function readIssues(value: unknown): unknown {
  // Tolerate a critic that still stringifies its object into `text`.
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.issues)) return record.issues;
  if (typeof record.text === "string") {
    try {
      const nested = JSON.parse(record.text);
      return Array.isArray(nested?.issues) ? nested.issues : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Validate one critic response segment by segment. A segment with unusable issues is
 * marked and kept rather than discarding the whole batch, so a single bad element never
 * costs the audit of its nineteen neighbours.
 */
export function parseAuditSegments(value: unknown, expectedIds: string[]): ParsedAuditSegment[] {
  const segments = Array.isArray((value as { segments?: unknown })?.segments)
    ? ((value as { segments: unknown[] }).segments as unknown[])
    : undefined;
  if (!segments) return expectedIds.map((id) => ({ id, issues: [], auditError: "malformed_json" }));
  const byId = new Map<string, unknown>();
  const duplicates = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    const id =
      typeof (segment as { id?: unknown })?.id === "string"
        ? (segment as { id: string }).id
        : expectedIds[index];
    if (id === undefined) continue;
    if (byId.has(id)) duplicates.add(id);
    else byId.set(id, segment);
  }
  return expectedIds.map((id) => {
    const raw = byId.get(id);
    if (raw === undefined || duplicates.has(id))
      return { id, issues: [], auditError: "invalid_issues" as const };
    const issues = z.array(qualityIssueSchema).max(12).safeParse(readIssues(raw));
    return issues.success
      ? { id, issues: issues.data }
      : { id, issues: [], auditError: "invalid_issues" as const };
  });
}
