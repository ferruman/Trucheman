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
/** Russian runs longer than English, Polish shorter; outside this a block was lost or padded. */
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
 * A scanned book writes the pronoun "I" as "1": «until 1 got here», «Because 1 do not hope».
 * All 37 standalone "1"s in job 02279a8b's source were this, and they were 26 of that run's
 * 27 dropped-number findings.
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
 * the one date that really had been lost. Calibers and model years are the bulk of it:
 * ".357" is «триста пятьдесят седьмой», "’49" is «сорок девятого».
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
 *
 * Only words the source itself writes lowercase count. A capitalized Latin word kept as-is
 * is a name, a brand or a title — Nine Inch Nails, MasterCard, Levi's — and keeping those is
 * correct, so flagging them buried the finding exactly the way a cognate would.
 */
function sourceResidue(source: string, translation: string): string[] {
  const sourceScript = dominantScript(source);
  if (sourceScript === "none" || dominantScript(translation) !== "cyrillic") return [];
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
 * word behind. «Ach, liebe Gott», «Ignis magnificus, veni», «Grateful Dead» are not — a book
 * keeps its German dialogue, its Latin incantation and its band names, and every one of those
 * sits inside a run of source text. Every residue this run of the book produced fell cleanly
 * on one side or the other, which is what makes the first kind worth paying a repair for and
 * the second kind worth only reporting.
 */
function isolatedResidue(translation: string, carried: string[]): string[] {
  if (!carried.length) return [];
  const wanted = new Set(carried.map((word) => word.toLocaleLowerCase()));
  const words = [...translation.matchAll(/[\p{L}\p{M}]+/gu)].map((match) => match[0]);
  const cyrillic = (word: string | undefined) => Boolean(word && /\p{Script=Cyrillic}/u.test(word));
  const isolated = new Set<string>();
  for (const [index, word] of words.entries()) {
    if (!wanted.has(word.toLocaleLowerCase())) continue;
    if (cyrillic(words[index - 1]) && cyrillic(words[index + 1])) isolated.add(word);
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
  if (original.length >= MIN_COMPARABLE) {
    const ratio = result.length / original.length;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO)
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
  // Times», «Science Fiction Reviews» — even when the source also uses the word lowercase in
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
