import type { ProviderInputSegment, ProviderSegment } from "../providers/provider.js";
import { expectedExpansion } from "../providers/response-validator.js";

/**
 * Deterministic per-segment defects, found by comparing a translation with its original.
 *
 * This is the check the paid critic cannot be trusted to make cheaply and the built-book
 * audit cannot make at all: `epub/consistency-audit.ts` only ever sees the target text, so
 * an omitted sentence or an untranslated paragraph is invisible to it. Everything here is
 * free, runs in both quality modes, and only reports — nothing is rewritten on its word.
 */
export type SegmentDefectKind =
  | "empty"
  | "untranslated"
  | "length_ratio"
  | "missing_numbers"
  | "source_residue"
  | "source_interference";
/** `spans` carries the exact words a repair has to replace, for the kinds that get repaired. */
export type SegmentDefect = {
  id: string;
  kind: SegmentDefectKind;
  detail: string;
  spans?: string[];
};

/** Below this a heading, a name, or a date is legitimately identical or lopsided. */
const MIN_COMPARABLE = 80;
const MIN_IDENTICAL = 40;
/**
 * How far either side of the expected length a translation may fall before the block was lost
 * or padded. Russian runs longer than English and Polish shorter, so the tolerance is what is
 * fixed here and the expectation is what varies by script.
 */
const MIN_RATIO = 0.5;
const MAX_RATIO = 2;
const MAX_REPORTED_EXAMPLES = 3;

function normalized(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Digit groups joined by a thousands separator are one number. English groups with a comma
 * and Russian with a space, so "$5,000" and «$5000» compared as ["5","000"] against ["5000"]
 * and reported a perfectly good amount as dropped. Requiring exactly three digits after each
 * separator keeps decimals — "3.14", «1,5» — out of it.
 */
function ungrouped(text: string) {
  return text.replace(/\d{1,3}(?:[.,\u00a0\u202f\u2009 '\u2019]\d{3})+/gu, (match) =>
    match.replace(/\D/gu, ""),
  );
}

/** H₂O writes its digit as U+2082. Unfolded, the source's plain "2" reads as dropped. */
function unsubscripted(text: string) {
  return text.replace(/[₀-₉]/gu, (digit) => String(digit.codePointAt(0)! - 0x2080));
}

function numbers(text: string) {
  return (ungrouped(unsubscripted(text)).match(/\d+/gu) ?? []).filter((value) => value.length <= 6);
}

/**
 * A scanned book can write the pronoun "I" as "1": «until 1 reached the hall». Treating
 * every such OCR error as a numeral creates false dropped-number findings.
 *
 * A bare "1" in front of a word is the trade: "1 mile" stops being checked, which costs one
 * digit in one block, against a book's worth of phantom findings burying the real ones.
 */
function unscanPronouns(text: string) {
  return text.replace(/(?<![\p{L}\p{N}])1(?=\s+\p{L})/gu, "I");
}

// ponytail: Russian only, 1–999 — what prose actually spells out. Any other language or
// larger value keeps reporting, which is the safe direction.
const RU_STEMS = new Map<number, string>([
  [1, "перв|одн"],
  [2, "втор|дв[уе]"],
  [3, "трет|тр[её]"],
  [4, "чётверт|четверт|четв[её]р"],
  [5, "пят"],
  [6, "шест"],
  [7, "седьм|сем"],
  [8, "восьм|восем"],
  [9, "девят"],
  [10, "десят"],
  [11, "одиннадцат"],
  [12, "двенадцат"],
  [13, "тринадцат"],
  [14, "четырнадцат"],
  [15, "пятнадцат"],
  [16, "шестнадцат"],
  [17, "семнадцат"],
  [18, "восемнадцат"],
  [19, "девятнадцат"],
  [20, "двадцат"],
  [30, "тридцат"],
  [40, "сорок"],
  [50, "пятьдесят|пятидесят"],
  [60, "шестьдесят|шестидесят"],
  [70, "семьдесят|семидесят"],
  [80, "восемьдесят|восьмидесят"],
  [90, "девяност"],
  [100, "ст[оа]|сот"],
  [200, "двест|двухсот"],
  [300, "трист|тр[её]хсот"],
  [400, "четырест|четыр[её]хсот"],
  [500, "пятьсот|пятисот"],
  [600, "шестьсот|шестисот"],
  [700, "семьсот|семисот"],
  [800, "восемьсот|восьмисот"],
  [900, "девятьсот|девятисот"],
]);

/**
 * Stems that must all appear for `value` to count as written out in words. "12" reads as
 * «двенадцатого», "22" as «двадцать второго» — reporting those as dropped numbers buried
 * a date that really was lost. Decimal labels and abbreviated years need the same handling:
 * ".357" can be «триста пятьдесят седьмой», "’49" can be «сорок девятого».
 */
function spelledOutStems(value: string): string[] {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999_999) return [];
  const thousands = Math.floor(n / 1000);
  if (!thousands) return hundredsStems(n);
  // «двадцать тысяч триста двадцать» for "20,320". Bare «тысяча» carries no numeral of its
  // own, so requiring a stem for a leading 1 would report every spelled-out thousand.
  return [
    ...(thousands === 1 ? [] : hundredsStems(thousands)),
    "тысяч",
    ...hundredsStems(n % 1000),
  ];
}

function hundredsStems(n: number): string[] {
  if (n < 1) return [];
  const parts: number[] = [];
  if (n >= 100) parts.push(Math.floor(n / 100) * 100);
  const rest = n % 100;
  if (rest >= 10 && rest < 20) parts.push(rest);
  else {
    if (rest >= 20) parts.push(Math.floor(rest / 10) * 10);
    if (rest % 10) parts.push(rest % 10);
  }
  return parts.map((part) => RU_STEMS.get(part)!);
}

/** «345 тысяч» and "345,000" are the same number written two ways. */
const RU_MAGNITUDES: Array<[scale: number, stem: string]> = [
  [1e9, "миллиард"],
  [1e6, "миллион"],
  [1e3, "тысяч"],
];

function isAbbreviatedMagnitude(value: string, translation: string) {
  const n = Number(value);
  return RU_MAGNITUDES.some(
    ([scale, stem]) =>
      n >= scale &&
      n % scale === 0 &&
      new RegExp(`(?<!\\d)${n / scale}(?!\\d)[^\\p{L}\\d]{0,3}${stem}`, "iu").test(translation),
  );
}

/** "a ’49 Mercury" is «Меркьюри» 1949 года: a two-digit year written out is not a loss. */
function isExpandedYear(value: string, translation: string) {
  return (
    value.length === 2 && new RegExp(`(?<!\\d)(?:19|20)${value}(?!\\d)`, "u").test(translation)
  );
}

function isSpelledOut(value: string, translation: string, targetTag: string | undefined) {
  if (isExpandedYear(value, translation)) return true;
  if (!targetTag?.toLocaleLowerCase().startsWith("ru")) return false;
  if (isAbbreviatedMagnitude(value, translation)) return true;
  const stems = spelledOutStems(value);
  return stems.length > 0 && stems.every((stem) => new RegExp(stem, "iu").test(translation));
}

const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/**
 * Which script a text is written in, decided by counting. The source language is not passed
 * in on purpose: a Japanese book carries English epigraphs and a Latin one carries Japanese
 * names, and every rule keyed on this wants the answer for the segment in hand.
 */
function dominantScript(text: string) {
  const counts = {
    latin: text.match(/\p{Script=Latin}/gu)?.length ?? 0,
    cyrillic: text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0,
    cjk: text.match(cjkPattern)?.length ?? 0,
  };
  const [[winner, top], [, runnerUp]] = Object.entries(counts).sort(
    ([, left], [, right]) => right - left,
  );
  return top === runnerUp ? "none" : winner;
}

/**
 * Words carried over from the original verbatim. Only checked when the two texts are in
 * different scripts: between two Latin languages a shared word is usually a name or a
 * cognate, and flagging those would bury the real finding.
 *
 * Only words the source itself writes lowercase count. A capitalized Latin word kept as-is
 * is a name or a title — White Rabbit, Cheshire Cat — and keeping those is
 * correct, so flagging them buried the finding exactly the way a cognate would.
 */
function sourceResidue(source: string, translation: string): string[] {
  const sourceScript = dominantScript(source);
  if (sourceScript === "none" || dominantScript(translation) !== "cyrillic") return [];
  // Japanese needs none of the care Latin does. There is no case to filter on and no cognate
  // to spare: a run of kana or kanji standing in Russian prose was not translated, full stop.
  if (sourceScript === "cjk")
    return [
      ...new Set(
        translation.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? [],
      ),
    ];
  if (sourceScript !== "latin") return [];
  const sourceWords = new Set(
    (source.match(/\p{Script=Latin}{4,}/gu) ?? [])
      .filter((word) => word === word.toLocaleLowerCase())
      .map((word) => word.toLocaleLowerCase()),
  );
  const carried = new Set<string>();
  for (const word of translation.match(/\p{Script=Latin}{4,}/gu) ?? []) {
    if (sourceWords.has(word.toLocaleLowerCase())) carried.add(word);
  }
  return [...carried];
}

/**
 * Of the words carried over, the ones with target-script words on both sides.
 *
 * «он formally поклонился ей» is interference: the model translated the sentence and left one
 * word behind. Intentionally preserved foreign dialogue and character names are not: a book
 * can keep those source-language spans, and each one sits inside a run of source text. The
 * first kind is worth repairing; the second is worth reporting only.
 */
/**
 * Words, with a CJK run counting as one of its own. Japanese writes no space, so a kanji run
 * left in Russian prose fuses with the word beside it and can no longer look isolated between
 * two Cyrillic neighbours. Splitting CJK runs into their own tokens routes those leaks into a
 * repair.
 */
const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const wordPattern = new RegExp(`[${CJK_CLASS}ー]+|(?:(?![${CJK_CLASS}])[\\p{L}\\p{M}])+`, "gu");

function isolatedResidue(translation: string, carried: string[]): string[] {
  const wanted = new Set(carried.map((word) => word.toLocaleLowerCase()));
  const words = [...translation.matchAll(wordPattern)];
  const cyrillic = (word: RegExpExecArray | undefined) =>
    Boolean(word && /\p{Script=Cyrillic}/u.test(word[0]));
  const quoted = (word: RegExpExecArray) => {
    const start = word.index ?? 0;
    const before = translation.slice(0, start).trimEnd().at(-1);
    const after = translation.slice(start + word[0].length).trimStart()[0];
    // Brackets mark a gloss the same way quotes mark a citation: «собираются они — о́ни (鬼)»
    // spells the term out in Russian and shows the original beside it, and the translation is
    // poorer without it. Repairing that away is the one thing this rule must not do.
    const pairs: Array<[string, string]> = [
      ["«", "»"],
      ["“", "”"],
      ["(", ")"],
      ["（", "）"],
      ["[", "]"],
      ["【", "】"],
    ];
    return pairs.some(([open, close]) => before === open && after === close);
  };
  const isolated = new Set<string>();
  for (const [index, word] of words.entries()) {
    const value = word[0];
    // An inflected leak need not occur verbatim in the source (crouching → crouched). A lone
    // lowercase Latin word between Cyrillic words is still strong evidence; names and
    // multi-word foreign expressions remain outside this rule.
    const sourceShaped = wanted.has(value.toLocaleLowerCase()) || /^[a-z]{4,}$/u.test(value);
    if (!sourceShaped || quoted(word)) continue;
    if (cyrillic(words[index - 1]) && cyrillic(words[index + 1])) isolated.add(word[0]);
  }
  return [...isolated];
}

export function scanSegment(
  source: string,
  translation: string,
  id: string,
  targetTag?: string,
): SegmentDefect[] {
  const original = normalized(source),
    result = normalized(translation);
  if (!original) return [];
  if (!result) return [{ id, kind: "empty", detail: "translation is empty" }];
  const defects: SegmentDefect[] = [];
  if (
    original.length >= MIN_IDENTICAL &&
    original.toLocaleLowerCase() === result.toLocaleLowerCase() &&
    // A word, not a letter: a page-number list ("i 1 2 3 … 40") is identical in every
    // language and has nothing to translate.
    /\p{L}{2,}/u.test(original)
  ) {
    defects.push({ id, kind: "untranslated", detail: "translation is identical to the original" });
    // Identical text trivially fails the ratio and residue checks too; one finding is enough.
    return defects;
  }
  /**
   * A block still written in the source's own writing system was not translated, whatever the
   * two texts differ by. Identity alone misses it: the editing pass runs over the untouched
   * source and normalizes its spacing, after which the strings no longer match. Residue misses
   * it too, and for the worst possible reason: `sourceResidue` gives up unless the *translation*
   * is dominantly Cyrillic, so a block that is entirely source text is the one case it skips.
   *
   * Scoped to the scripts that cannot be confused with a target language's own: a Latin run
   * inside a Latin-alphabet translation is a name or a kept quotation, which `sourceResidue`
   * already judges with the care that needs.
   */
  if (
    dominantScript(result) === "cjk" &&
    dominantScript(original) === "cjk" &&
    // Length is the wrong question for a whole block written entirely in the source's script:
    // a chapter heading typeset one character per span merges into a unit of thirteen, under
    // any floor calibrated on Latin. A block carrying no target-script character at all was
    // not translated, at any length —
    // while a lone kanji glossing a term inside Russian prose, «они (鬼)», sits in a block
    // that is dominantly Cyrillic and is never in question here.
    (!/\p{Script=Cyrillic}|\p{Script=Latin}/u.test(result) ||
      result.length >= MIN_IDENTICAL / expectedExpansion(result))
  ) {
    defects.push({
      id,
      kind: "untranslated",
      detail: "translation is still written in the source's script",
    });
    // Identical text trivially fails the ratio and residue checks too; one finding is enough.
    return defects;
  }
  if (original.length >= MIN_COMPARABLE) {
    const ratio = result.length / original.length;
    // Centring on the expansion the source predicts keeps exactly the tolerance above: a
    // Japanese block still has to fall below half, or exceed twice, what its length predicts.
    const expected = expectedExpansion(original);
    if (ratio < MIN_RATIO * expected || ratio > MAX_RATIO * expected)
      defects.push({
        id,
        kind: "length_ratio",
        detail: `translation is ${ratio.toFixed(2)}× the length of the original`,
      });
  }
  // Only the source is unscanned: a "1" in the translation is a number the model wrote.
  const expected = numbers(
      dominantScript(original) === "latin" ? unscanPronouns(original) : original,
    ),
    present = numbers(result);
  const missing = expected.filter((value) => {
    const index = present.indexOf(value);
    if (index < 0) return !isSpelledOut(value, result, targetTag);
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
  const isolated = isolatedResidue(result, residue);
  if (isolated.length)
    defects.push({
      id,
      kind: "source_interference",
      detail: `source words left inside the translation: ${isolated
        .slice(0, MAX_REPORTED_EXAMPLES)
        .join(", ")}`,
      spans: isolated,
    });
  // Capitalized in the *translation* is a title or a name kept on purpose — «The New York
  // Rabbit», «Mock Turtle» — even when the source also uses the word lowercase in
  // its prose. Only the reported bucket is filtered: an isolated word is interference and
  // gets repaired whatever its case.
  const preserved = residue.filter(
    (word) => !isolated.includes(word) && word === word.toLocaleLowerCase(),
  );
  if (preserved.length)
    defects.push({
      id,
      kind: "source_residue",
      detail: `untranslated source words: ${preserved.slice(0, MAX_REPORTED_EXAMPLES).join(", ")}`,
    });
  return defects;
}

export function scanSegments(
  source: ProviderInputSegment[],
  translated: ProviderSegment[],
  targetTag?: string,
): SegmentDefect[] {
  const translatedById = new Map(translated.map((segment) => [segment.id, segment.text]));
  return source.flatMap((segment) =>
    "text" in segment && typeof segment.text === "string"
      ? scanSegment(segment.text, translatedById.get(segment.id) ?? "", segment.id, targetTag)
      : [],
  );
}
