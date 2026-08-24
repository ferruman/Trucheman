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

const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/**
 * How much longer than its source a faithful translation of this text is expected to be.
 *
 * Every length rule below and in `jobs/segment-scan.ts` was calibrated between languages that
 * write about as much as each other, where the answer is the same size as its input. Japanese
 * is not one of those: it says in one character about what three Latin ones do, so a correct
 * Russian answer is roughly three times its source and trips a rule whose widest bound is 2.2.
 * That is not a theoretical drift — it rejected some sixty per cent of the translation
 * requests of a Japanese book, each rejection paying for an answer that was perfectly good.
 */
export function expectedExpansion(source: string): number {
  const cjk = source.match(cjkPattern)?.length ?? 0;
  return cjk * 2 > source.length ? 3 : 1;
}

/** Below this a heading, a name or a date is legitimately lopsided against its neighbour. */
const MIN_ALIGNMENT_TEXT = 40;
/** Wider than any language pair drifts: outside it the text belongs to another segment. */
const OWN_RATIO = { min: 0.5, max: 2.2 };
const NEIGHBOUR_RATIO = { min: 0.75, max: 1.5 };
/** An answer this much longer than its own input has taken in text from somewhere. */
const GLUED_OWN_RATIO = 1.6;
const GLUED_PAIR_RATIO = { min: 0.8, max: 1.25 };

/**
 * Segments whose answer covers more of the book than the segment does.
 *
 * A source sentence split across two blocks — `…one foot in the rabbit-hole, the` /
 * `other on the riverbank…` — invites the model to answer both halves under the first id.
 * From there it goes one of two ways, and the ids stay perfect either way, so
 * `validateProviderResponse` passes the batch and the damage reaches the book:
 *
 * - it drops the second id's own answer and shifts every later answer back by one, padding
 *   the tail with a duplicate — the whole rest of the batch then carries its neighbour's
 *   text. Caught by an answer that is the wrong size for its own input and the right size
 *   for the next one.
 * - or it answers the second id as well, and the glued half is published twice. Caught by an
 *   answer that is about as long as its own input and the next one together.
 *
 * Neither rule subsumes the other, so a single segment flagged by either shape is enough.
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
    // Measure the answer against what its source predicts, so every bound below keeps the
    // meaning it was calibrated with instead of being re-tuned per language pair.
    const scaled = answer.length / expectedExpansion(own + neighbour);
    const ownRatio = scaled / own.length;
    const neighbourRatio = scaled / neighbour.length;
    const pairRatio = scaled / (own.length + neighbour.length);
    const shifted =
      (ownRatio < OWN_RATIO.min || ownRatio > OWN_RATIO.max) &&
      neighbourRatio >= NEIGHBOUR_RATIO.min &&
      neighbourRatio <= NEIGHBOUR_RATIO.max;
    const glued =
      ownRatio >= GLUED_OWN_RATIO &&
      pairRatio >= GLUED_PAIR_RATIO.min &&
      pairRatio <= GLUED_PAIR_RATIO.max;
    if (shifted || glued) misaligned.push(expected[index].id);
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
