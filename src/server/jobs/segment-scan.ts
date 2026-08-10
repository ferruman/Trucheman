import type { ProviderInputSegment, ProviderSegment } from "../providers/provider.js";

/**
 * Deterministic per-segment defects, found by comparing a translation with its original.
 *
 * This is the check the paid critic cannot be trusted to make cheaply and the built-book
 * audit cannot make at all: `epub/consistency-audit.ts` only ever sees the target text, so
 * an omitted sentence or an untranslated paragraph is invisible to it. Everything here is
 * free, runs in both quality modes, and only reports — nothing is rewritten on its word.
 */
export type SegmentDefectKind =
  "empty" | "untranslated" | "length_ratio" | "missing_numbers" | "source_residue";
export type SegmentDefect = { id: string; kind: SegmentDefectKind; detail: string };

/** Below this a heading, a name, or a date is legitimately identical or lopsided. */
const MIN_COMPARABLE = 80;
const MIN_IDENTICAL = 40;
/** Russian runs longer than English, Polish shorter; outside this a block was lost or padded. */
const MIN_RATIO = 0.5;
const MAX_RATIO = 2;
const MAX_REPORTED_EXAMPLES = 3;

function normalized(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function numbers(text: string) {
  return (text.match(/\d+/gu) ?? []).filter((value) => value.length <= 6);
}

/** Latin against Cyrillic is the only script split the supported languages can produce. */
function dominantScript(text: string) {
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  if (latin === cyrillic) return "none";
  return latin > cyrillic ? "latin" : "cyrillic";
}

/**
 * Words carried over from the original verbatim. Only checked when the two texts are in
 * different scripts: between two Latin languages a shared word is usually a name or a
 * cognate, and flagging those would bury the real finding.
 */
function sourceResidue(source: string, translation: string): string[] {
  const sourceScript = dominantScript(source);
  if (sourceScript === "none" || dominantScript(translation) !== "cyrillic") return [];
  if (sourceScript !== "latin") return [];
  const sourceWords = new Set(
    (source.toLocaleLowerCase().match(/\p{Script=Latin}{4,}/gu) ?? []).map((word) => word),
  );
  const carried = new Set<string>();
  for (const word of translation.match(/\p{Script=Latin}{4,}/gu) ?? []) {
    if (sourceWords.has(word.toLocaleLowerCase())) carried.add(word);
  }
  return [...carried];
}

export function scanSegment(source: string, translation: string, id: string): SegmentDefect[] {
  const original = normalized(source),
    result = normalized(translation);
  if (!original) return [];
  if (!result) return [{ id, kind: "empty", detail: "translation is empty" }];
  const defects: SegmentDefect[] = [];
  if (
    original.length >= MIN_IDENTICAL &&
    original.toLocaleLowerCase() === result.toLocaleLowerCase() &&
    /\p{L}/u.test(original)
  ) {
    defects.push({ id, kind: "untranslated", detail: "translation is identical to the original" });
    // Identical text trivially fails the ratio and residue checks too; one finding is enough.
    return defects;
  }
  if (original.length >= MIN_COMPARABLE) {
    const ratio = result.length / original.length;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO)
      defects.push({
        id,
        kind: "length_ratio",
        detail: `translation is ${ratio.toFixed(2)}× the length of the original`,
      });
  }
  const expected = numbers(original),
    present = numbers(result);
  const missing = expected.filter((value) => {
    const index = present.indexOf(value);
    if (index < 0) return true;
    present.splice(index, 1);
    return false;
  });
  if (missing.length)
    defects.push({
      id,
      kind: "missing_numbers",
      detail: `numbers missing from the translation: ${missing.slice(0, MAX_REPORTED_EXAMPLES).join(", ")}`,
    });
  const residue = sourceResidue(original, result);
  if (residue.length)
    defects.push({
      id,
      kind: "source_residue",
      detail: `untranslated source words: ${residue.slice(0, MAX_REPORTED_EXAMPLES).join(", ")}`,
    });
  return defects;
}

export function scanSegments(
  source: ProviderInputSegment[],
  translated: ProviderSegment[],
): SegmentDefect[] {
  const translatedById = new Map(translated.map((segment) => [segment.id, segment.text]));
  return source.flatMap((segment) =>
    "text" in segment && typeof segment.text === "string"
      ? scanSegment(segment.text, translatedById.get(segment.id) ?? "", segment.id)
      : [],
  );
}
