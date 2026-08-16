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
import { expectedExpansion } from "../providers/response-validator.js";
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

/**
 * The critic occasionally argues itself out of a finding but still emits the issue object.
 * Keep this gate deliberately narrow: it rejects explicit no-defect conclusions and explicit
 * uncertainty, not reasons that merely acknowledge one correct detail before naming another.
 */
const nonActionableReasonPatterns = [
  /\b(?:therefore\s+)?this is not an? (?:error|issue)\b/iu,
  /\bno (?:issue|inconsistency|strong defect|clear defect|real defect)\b/iu,
  /\bnot (?:a )?(?:strong|clear|real|actual) defect\b/iu,
  /\bactually acceptable\b/iu,
  /\b(?:it|this|the (?:translation|rendering|wording|phrase|form)) is acceptable\b/iu,
  /\bborderline\b/iu,
  /\blow[- ]confidence\b/iu,
  /не является (?:ошибкой|дефектом|проблемой)/iu,
  /(?:ошибки|проблемы|несоответствия) нет/iu,
  /не стоит (?:это )?отмечать/iu,
  /низк\p{L}* уверенн\p{L}*/iu,
  /(?:это|вариант|форма|склонение) (?:полностью )?(?:корректн\p{L}*|допустим\p{L}*)/iu,
  /перевод (?:в данном сегменте )?верен/iu,
  /основани(?:й|я) для исправления нет/iu,
  /изменени\p{L}*[^.!?]{0,80}(?:противоречит|является ошибк)/iu,
  /не буду (?:включать|отмечать)[^.!?]{0,80}(?:сомнительн|замечани)/iu,
  /(?:я )?не уверен/iu,
  /требуется уточнение/iu,
];

function reasonContradictsEvidence(
  issue: QualityIssue,
  input?: ProviderAuditInputSegment,
): boolean {
  const reason = issue.reason;
  const quotedForms = [...reason.matchAll(/[«“"]([^»”"]+)[»”"]/gu)].map((match) =>
    match[1].trim().toLocaleLowerCase(),
  );
  if (new Set(quotedForms).size < quotedForms.length) return true;
  if (
    issue.type === "semantic_error" &&
    issue.severity === "high" &&
    /перевод (?:в целом |основн\p{L}* )?(?:сохраняет|передаёт) (?:смысл|значение)/iu.test(reason)
  )
    return true;
  // The critic sometimes describes punctuation as outside the guillemets while copying a
  // span that visibly has it inside. Trust the exact span, not that explanation.
  if (
    /(?:после|снаружи|outside|after)[^.!?]{0,50}(?:кавыч|quote)/iu.test(reason) &&
    /[.!?…]»$/u.test(issue.span)
  )
    return true;
  // A proposed "correct" form that is already the reported span asks repair to make no change.
  for (const match of reason.matchAll(
    /(?:правильн\p{L}*|корректн\p{L}*|следует|требу\p{L}*|предписыва\p{L}*)[^«»]{0,100}«([^»]+)»/giu,
  )) {
    if (issue.span.includes(match[1])) return true;
  }
  // Russian terminal full stops normally follow the closing guillemet. The critic repeatedly
  // demanded English placement while copying a span that already followed the Russian rule.
  if (
    /(?:точк|period|full stop)[^.!?]{0,100}(?:внутри|перед закрыва|inside|before the closing)/iu.test(
      reason,
    ) &&
    /»\.$/u.test(issue.span)
  )
    return true;
  // A claimed missing word that is visibly present in the critic's own exact span is a
  // self-contradiction, not a repair request.
  for (const match of reason.matchAll(
    /(?:отсутствует|пропущено|пропущен)\s+(?:слово\s+)?["'“«]([^"'”»]+)["'”»]/giu,
  )) {
    if (issue.span.toLocaleLowerCase().includes(match[1].toLocaleLowerCase())) return true;
  }
  // Russian typography requires a space after the dialogue dash. Reject the recurring
  // critic hallucination that asks to remove it from an already correct `— Реплика` span.
  if (
    /тире без пробела|no space after (?:the )?dash/iu.test(reason) &&
    /—\s+\p{L}/u.test(issue.span)
  )
    return true;
  // A dialogue line beginning with a dash does not need quotation marks. Likewise, Russian
  // direct speech after authorial words is conventionally introduced by `: —`.
  if (
    /^—\s/u.test(issue.span) &&
    /(?:не хватает|отсутствует|требу\p{L}*)[^.!?]{0,50}(?:кавыч|closing quote)/iu.test(reason)
  )
    return true;
  if (
    /:\s+—/u.test(issue.span) &&
    /(?:неверн|некоррект|наруш)[^.!?]{0,80}(?:двоеточ|тире)|(?:двоеточ|тире)[^.!?]{0,80}(?:неверн|некоррект|наруш)/iu.test(
      reason,
    )
  )
    return true;
  if (
    /дефис[^.!?]{0,50}(?:опущен|отсутствует)|(?:опущен|отсутствует)[^.!?]{0,50}дефис/iu.test(
      reason,
    ) &&
    issue.span.includes("-")
  )
    return true;
  if (
    /(?:объедин|слит|merge)[^.!?]{0,80}(?:запят|comma)/iu.test(reason) &&
    /[.!?…]$/u.test(issue.span)
  )
    return true;
  if (!input) return false;
  // Roman-numeral headings are intentionally language-neutral.
  if (
    input.original.trim() === input.editedTranslation.trim() &&
    /^(?=[IVXLCDM]+$)M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/u.test(
      input.original.trim(),
    )
  )
    return true;
  // "Missing negation" is a high-risk semantic claim. Require the reason to quote the exact
  // negative source phrase: a negation elsewhere in a long segment is not evidence for it.
  if (
    /(?:опущен\p{L}* отрицан|missing (?:a |the )?negation)/iu.test(reason) &&
    /[A-Za-z]/u.test(input.original)
  ) {
    const source = input.original.toLocaleLowerCase();
    const citedNegativeSource = [...reason.matchAll(/["“«]([^"”»]{2,160})["”»]/gu)].some(
      ([, quote]) =>
        /\b(?:no|not|never|neither|nor|nothing|nobody|nowhere|without)\b|n['’]t\b/iu.test(quote) &&
        source.includes(quote.toLocaleLowerCase()),
    );
    if (!citedNegativeSource) return true;
  }
  // A source word deliberately preserved as the entire contents of target-language quotes
  // is a sign, title, label, or cited expression—not an accidentally untranslated word.
  if (
    issue.type === "source_language_interference" &&
    input.original.toLocaleLowerCase().includes(issue.span.toLocaleLowerCase()) &&
    (input.editedTranslation.includes(`«${issue.span}»`) ||
      input.editedTranslation.includes(`“${issue.span}”`))
  )
    return true;
  return false;
}

export function isActionableQualityIssue(
  issue: QualityIssue,
  input?: ProviderAuditInputSegment,
): boolean {
  return (
    !nonActionableReasonPatterns.some((pattern) => pattern.test(issue.reason)) &&
    !reasonContradictsEvidence(issue, input)
  );
}

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
    const input = inputById.get(segment.id);
    const edited = input?.editedTranslation ?? "";
    const issues = parsed.data.issues.filter(
      (issue) => edited.includes(issue.span) && isActionableQualityIssue(issue, input),
    );
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
    // «Пустая, пустее некуда» is an adjective followed by its comparative, not a fragment
    // duplicated by repair.
    if (/(?:ее|ей)$/u.test(current.value)) continue;
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
  // Scaled by what the source's script predicts, or the block a Japanese book never translated
  // can never be repaired: its correct Russian is three times the length of the text it
  // replaces, and a bound of twice rejected all fourteen of them on one volume — the repair
  // was generated correctly every time and thrown away at this gate.
  if (
    repaired.length >
    Math.max(edited.length, original.length) * 2 * expectedExpansion(original) + 20
  )
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
