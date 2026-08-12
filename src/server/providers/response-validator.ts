import { providerResultSchema } from "../../shared/api/schemas.js";
import type { ProviderInputSegment, ProviderResponse, ProviderSegment } from "./provider.js";

export function validateProviderResponse(
  response: ProviderResponse,
  expected: ProviderInputSegment[],
): ProviderResponse {
  const result = providerResultSchema.safeParse({ segments: response.segments });
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Provider response segments must contain non-empty string id and text fields${
        detail ? ` (${detail})` : ""
      }`,
    );
  }
  const parsed = result.data;
  const ids = expected.map((item) => item.id);
  const got = parsed.segments.map((item) => item.id);
  if (
    got.length !== ids.length ||
    new Set(got).size !== got.length ||
    got.some((id, index) => id !== ids[index])
  ) {
    throw new Error("Provider response IDs do not exactly match the request");
  }
  if (response.finishReason && response.finishReason !== "stop") {
    throw new Error("Provider response was truncated");
  }
  return {
    ...response,
    // The schema strips unknown keys; structured audit issues must survive it.
    segments: parsed.segments.map((segment, index) => {
      const issues = response.segments[index]?.issues;
      return issues ? { ...segment, issues } : segment;
    }),
  };
}

function comparisonText(segment: ProviderInputSegment): string {
  if ("text" in segment) return segment.text;
  if ("editedTranslation" in segment) return segment.editedTranslation;
  return segment.draft;
}

/** Below this a heading, a name or a date is legitimately lopsided against its neighbour. */
const MIN_ALIGNMENT_TEXT = 40;
/** Wider than any language pair drifts: outside it the text belongs to another segment. */
const OWN_RATIO = { min: 0.5, max: 2.2 };
const NEIGHBOUR_RATIO = { min: 0.75, max: 1.5 };

/**
 * Segments whose answer is one position out of step with the request.
 *
 * A source sentence split across two blocks — `…one foot in the House of Shadows, the` /
 * `other on an empty street…` — invites the model to answer both halves under the first id
 * and then shift every remaining answer back by one, padding the tail with a duplicate. The
 * ids stay perfect, so `validateProviderResponse` passes the batch and the book silently ends
 * up with a dozen paragraphs carrying their neighbour's text. The signature is a segment whose
 * answer is the wrong size for its own input and the right size for the next one. Measured
 * over the 2087 finished batches in `data/jobs`, every segment this flags was that bug and
 * none was a legitimately lopsided paragraph, so a single flagged segment is enough.
 */
export function misalignedSegmentIds(
  expected: ProviderInputSegment[],
  actual: ProviderSegment[],
): string[] {
  const answers = new Map(actual.map((segment) => [segment.id, segment.text]));
  const misaligned: string[] = [];
  for (let index = 0; index < expected.length - 1; index++) {
    const own = comparisonText(expected[index]);
    const neighbour = comparisonText(expected[index + 1]);
    const answer = answers.get(expected[index].id) ?? "";
    if (
      own.length < MIN_ALIGNMENT_TEXT ||
      neighbour.length < MIN_ALIGNMENT_TEXT ||
      answer.length < MIN_ALIGNMENT_TEXT
    ) {
      continue;
    }
    const ownRatio = answer.length / own.length;
    const neighbourRatio = answer.length / neighbour.length;
    if (
      (ownRatio < OWN_RATIO.min || ownRatio > OWN_RATIO.max) &&
      neighbourRatio >= NEIGHBOUR_RATIO.min &&
      neighbourRatio <= NEIGHBOUR_RATIO.max
    ) {
      misaligned.push(expected[index].id);
    }
  }
  return misaligned;
}

export function qualityWarnings(
  expected: ProviderInputSegment[],
  actual: ProviderSegment[],
): string[] {
  const warnings: string[] = [];
  for (const expectedSegment of expected) {
    const actualSegment = actual.find((item) => item.id === expectedSegment.id);
    const sourceText = comparisonText(expectedSegment);
    if (actualSegment && actualSegment.text.length > Math.max(1000, sourceText.length * 4)) {
      warnings.push(`Suspicious length for ${expectedSegment.id}`);
    }
    if (actualSegment?.text.includes("As an AI")) {
      warnings.push(`Service boilerplate in ${expectedSegment.id}`);
    }
  }
  return warnings;
}
