import { agreementFixes } from "../epub/morphology.js";
import type { LanguageAuditDocument, LanguageDocument, LanguageModule } from "./types.js";

function replaceCounted(
  value: string,
  pattern: RegExp,
  replacement: (...values: string[]) => string,
) {
  let count = 0;
  const text = value.replace(pattern, (...values: string[]) => {
    count++;
    return replacement(...values);
  });
  return { text, count };
}

export function normalizeRussianConsistencyMechanics(documents: LanguageDocument[]) {
  let applied = 0;
  const rules: Array<[RegExp, (...values: string[]) => string]> = [
    [/«(?:\s*«)+/gu, () => "«"],
    [/(?:»\s*)+»/gu, () => "»"],
    [
      /(\d{1,3})\s*°\s*(\d{1,2})\s*[′´']/gu,
      (_match, degrees, minutes) => `${degrees}° ${minutes}′`,
    ],
    [
      /«([^«»\n]{1,240})»(\s*,?\s*[—–][^«»\n]{1,200}?[.!?…]\s*[—–]\s[^«»\n]{1,400}?)»/gu,
      (_match, quoted, attribution) => `«${quoted}${attribution}»`,
    ],
    [/«[\t ]+/gu, () => "«"],
    [/[\t ]+»/gu, () => "»"],
    [/«\s*«/gu, () => "«"],
    [/»\s*»/gu, () => "»"],
  ];
  for (const document of documents) {
    const lengths = document.editedSegments.map((segment) => segment.text.length);
    const joined = document.editedSegments.map((segment) => segment.text).join("");
    const straightQuotes = replaceCounted(joined, /"/gu, (_match, offset) => {
      const index = Number(offset);
      const previous = joined[index - 1] ?? "";
      const nextNonSpace = joined.slice(index + 1).match(/\S/u)?.[0] ?? "";
      const opening =
        (!previous || /\s|[([{—:;,]/u.test(previous)) && /[\p{L}\p{N}]/u.test(nextNonSpace);
      return opening ? "«" : "»";
    });
    applied += straightQuotes.count;
    let position = 0;
    for (const [index, segment] of document.editedSegments.entries()) {
      segment.text = straightQuotes.text.slice(position, position + lengths[index]);
      position += lengths[index];
    }
    const unmatchedOpenings: number[] = [];
    let unmatchedClosings = 0;
    for (const [index, character] of [...straightQuotes.text].entries()) {
      if (character === "«") unmatchedOpenings.push(index);
      else if (character === "»") {
        if (unmatchedOpenings.length) unmatchedOpenings.pop();
        else unmatchedClosings++;
      }
    }
    if (unmatchedOpenings.length === 1 && unmatchedClosings === 0) {
      let openingSegment = -1;
      let boundary = 0;
      for (const [index, length] of lengths.entries()) {
        boundary += length;
        if (unmatchedOpenings[0] < boundary) {
          openingSegment = index;
          break;
        }
      }
      const inlineContent = document.editedSegments[openingSegment + 1];
      if (
        inlineContent &&
        inlineContent.text.trim().length > 0 &&
        inlineContent.text.length <= 200 &&
        !/[«»]/u.test(inlineContent.text)
      ) {
        inlineContent.text += "»";
        applied++;
      }
    }
    for (const segment of document.editedSegments) {
      for (const [pattern, replacement] of rules) {
        const result = replaceCounted(segment.text, pattern, replacement);
        segment.text = result.text;
        applied += result.count;
      }
    }
  }
  return applied;
}

const NUMBER_STEMS = new Map<number, string>([
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

function hundredsStems(value: number): string[] {
  if (value < 1) return [];
  const parts: number[] = [];
  if (value >= 100) parts.push(Math.floor(value / 100) * 100);
  const rest = value % 100;
  if (rest >= 10 && rest < 20) parts.push(rest);
  else {
    if (rest >= 20) parts.push(Math.floor(rest / 10) * 10);
    if (rest % 10) parts.push(rest % 10);
  }
  return parts.map((part) => NUMBER_STEMS.get(part)!);
}

function numberStems(value: string): string[] {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 999_999) return [];
  const thousands = Math.floor(number / 1000);
  if (!thousands) return hundredsStems(number);
  return [
    ...(thousands === 1 ? [] : hundredsStems(thousands)),
    "тысяч",
    ...hundredsStems(number % 1000),
  ];
}

const MAGNITUDES: Array<[scale: number, stem: string]> = [
  [1e9, "миллиард"],
  [1e6, "миллион"],
  [1e3, "тысяч"],
];

export function isRussianNumberWrittenOut(value: string, text: string) {
  const number = Number(value);
  if (
    MAGNITUDES.some(
      ([scale, stem]) =>
        number >= scale &&
        number % scale === 0 &&
        new RegExp(`(?<!\\d)${number / scale}(?!\\d)[^\\p{L}\\d]{0,3}${stem}`, "iu").test(text),
    )
  )
    return true;
  const stems = numberStems(value);
  return stems.length > 0 && stems.every((stem) => new RegExp(stem, "iu").test(text));
}

function guillemetBalance(text: string) {
  let depth = 0;
  let unmatchedClosings = 0;
  let continuations = 0;
  for (const line of text.split("\n")) {
    let paragraph = line;
    if (depth > 0 && paragraph.trimStart().startsWith("«")) {
      continuations++;
      paragraph = paragraph.replace("«", "");
    }
    for (const character of paragraph) {
      if (character === "«") depth++;
      else if (character === "»") {
        if (depth > 0) depth--;
        else unmatchedClosings++;
      }
    }
  }
  return { unmatchedOpenings: depth, unmatchedClosings, continuations };
}

const capitalizedWordPattern = /(?<![\p{L}\p{N}])[А-ЯЁ][а-яё]{2,}/gu;
const nameStopWords = new Set([
  "Это",
  "Этот",
  "Эта",
  "После",
  "Когда",
  "Однако",
  "Затем",
  "Тогда",
  "Если",
  "Хотя",
  "Потом",
  "Самое",
  "Всё",
  "Все",
]);

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function nameClusters(text: string) {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(capitalizedWordPattern)) {
    const word = match[0];
    const preceding = text.slice(0, match.index).trimEnd().at(-1);
    if (nameStopWords.has(word) || !preceding || /[.!?]/u.test(preceding)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const words = [...counts].filter(([word, count]) => word.length >= 5 && count >= 2);
  const clusters: Array<Array<{ value: string; count: number }>> = [];
  const used = new Set<string>();
  for (const [word, count] of words) {
    if (used.has(word)) continue;
    const variants = [{ value: word, count }];
    for (const [candidate, candidateCount] of words) {
      let commonPrefix = 0;
      while (
        commonPrefix < Math.min(word.length, candidate.length) &&
        word[commonPrefix]?.toLocaleLowerCase() === candidate[commonPrefix]?.toLocaleLowerCase()
      ) {
        commonPrefix++;
      }
      const likelyInflection = commonPrefix >= Math.min(word.length, candidate.length) - 2;
      if (
        candidate !== word &&
        !used.has(candidate) &&
        !likelyInflection &&
        Math.abs(candidate.length - word.length) <= 2 &&
        editDistance(word.toLocaleLowerCase(), candidate.toLocaleLowerCase()) <= 2
      ) {
        variants.push({ value: candidate, count: candidateCount });
        used.add(candidate);
      }
    }
    used.add(word);
    if (variants.length > 1) clusters.push(variants);
  }
  return clusters;
}

function clipped(value: string, max = 320) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function quoteReport(text: string) {
  const opening = text.match(/«/g)?.length ?? 0;
  const closing = text.match(/»/g)?.length ?? 0;
  const straight = text.match(/"/g)?.length ?? 0;
  const hybrid = text.match(/"[^"\n]{0,240}»|«[^«\n]{0,240}"/g)?.map((item) => clipped(item)) ?? [];
  const duplicated = text.match(/«\s*«|»\s*»/g)?.length ?? 0;
  const balance = guillemetBalance(text);
  return {
    opening,
    closing,
    straight,
    ...balance,
    balanced: balance.unmatchedOpenings === 0 && balance.unmatchedClosings === 0,
    hybrid,
    duplicated,
  };
}

const yoHomographs = new Set(
  `все всем всех чем небо падеж осел слез поем совершенный узнаем признаем берет ведро мел`.split(
    /\s+/u,
  ),
);
const yoWordPattern = /[\p{L}\p{M}]*[её][\p{L}\p{M}]*/giu;

function yoVariants(text: string) {
  const forms = new Map<string, Set<string>>();
  for (const match of text.matchAll(yoWordPattern)) {
    const word = match[0].toLocaleLowerCase();
    const key = word.replaceAll("ё", "е");
    const variants = forms.get(key) ?? new Set<string>();
    variants.add(word);
    forms.set(key, variants);
  }
  return [...forms.entries()]
    .filter(
      ([key, variants]) =>
        !yoHomographs.has(key) &&
        variants.size > 1 &&
        [...variants].some((word) => word.includes("ё")),
    )
    .map(([key, variants]) => ({ key, variants: [...variants].sort() }));
}

function diagnoseRussianConsistency(documents: LanguageDocument[]) {
  const documentReports = documents.map((document) => {
    const text = document.editedSegments.map((segment) => segment.text).join("\n");
    const segmentsWithYo = document.editedSegments.filter((segment) =>
      /ё/iu.test(segment.text),
    ).length;
    let currentWithoutYoChars = 0;
    let longestWithoutYoChars = 0;
    for (const segment of document.editedSegments) {
      if (!/[а-я]/iu.test(segment.text)) continue;
      if (/ё/iu.test(segment.text)) currentWithoutYoChars = 0;
      else currentWithoutYoChars += segment.text.length;
      longestWithoutYoChars = Math.max(longestWithoutYoChars, currentWithoutYoChars);
    }
    const yoCount = text.match(/ё/giu)?.length ?? 0;
    return {
      id: document.id,
      quotes: quoteReport(text),
      yo: {
        variants: yoVariants(text),
        segmentsWithYo,
        segmentsWithoutYo: document.editedSegments.length - segmentsWithYo,
        longestWithoutYoChars,
        possibleDrift: yoCount >= 3 && longestWithoutYoChars >= 4000,
      },
    };
  });
  const warningCount = documentReports.reduce(
    (total, document) =>
      total +
      (document.quotes.balanced ? 0 : 1) +
      (document.quotes.straight ? 1 : 0) +
      document.quotes.hybrid.length +
      document.quotes.duplicated +
      document.yo.variants.length +
      (document.yo.possibleDrift ? 1 : 0),
    0,
  );
  return { documents: documentReports, warningCount };
}

function auditRussianEpub(documents: LanguageAuditDocument[]) {
  const text = documents.map((document) => document.text).join("\n");
  const quotes = documents.map((document) => ({
    id: document.id,
    opening: document.text.match(/«/gu)?.length ?? 0,
    closing: document.text.match(/»/gu)?.length ?? 0,
    straight: document.text.match(/"/gu)?.length ?? 0,
    ...guillemetBalance(document.text),
  }));
  const yoDocuments = documents.map((document) => ({
    id: document.id,
    yo: document.text.match(/ё/giu)?.length ?? 0,
    cyrillicWords: document.text.match(/[а-яё]+/giu)?.length ?? 0,
  }));
  const yoWindows = Array.from({ length: Math.ceil(text.length / 4000) }, (_, index) => {
    const start = index * 4000;
    const value = text.slice(start, start + 4000);
    return {
      start,
      end: start + value.length,
      yo: value.match(/ё/giu)?.length ?? 0,
      cyrillicWords: value.match(/[а-яё]+/giu)?.length ?? 0,
    };
  });
  const coordinates = [...text.matchAll(/(\d{1,3})\s*°(\s*)(\d{1,2})(\s*)([′´'])/gu)].map(
    (match) => ({
      value: match[0],
      mark: match[5],
      canonical: `${match[1]}° ${match[3]}′`,
      canonicalSpacing: match[2] === " " && match[4] === "",
    }),
  );
  const hyphenStreet = [
    ...text.matchAll(/(?<![\p{L}\p{N}])([А-ЯЁ][а-яё]+)-стрит(?![\p{L}\p{N}])/gu),
  ].map((match) => match[1]);
  const wordStreet = [
    ...text.matchAll(/(?<![\p{L}\p{N}])улиц(?:а|е|у|ы|ей)\s+([А-ЯЁ][а-яё]+)/giu),
  ].map((match) => match[1]);
  const warnings: string[] = [];
  for (const quote of quotes) {
    if (quote.unmatchedOpenings || quote.unmatchedClosings)
      warnings.push(
        `${quote.id}: unbalanced guillemets, ${quote.unmatchedOpenings} unclosed and ${quote.unmatchedClosings} unopened`,
      );
    if (quote.straight) warnings.push(`${quote.id}: ${quote.straight} straight double quote(s)`);
  }
  if (yoDocuments.some((document) => document.cyrillicWords >= 100 && document.yo === 0))
    warnings.push("Possible ё drift: a substantial Russian document contains no ё");
  if (
    (text.match(/ё/giu)?.length ?? 0) >= 3 &&
    yoWindows.some((window) => window.cyrillicWords >= 300 && window.yo === 0)
  )
    warnings.push("Possible ё drift: a 4000-character Russian window contains no ё");
  const streetStem = (value: string) => value.toLocaleLowerCase().slice(0, 5);
  const hyphenStreetStems = new Set(hyphenStreet.map(streetStem));
  if (wordStreet.some((value) => hyphenStreetStems.has(streetStem(value))))
    warnings.push("Mixed Russian street-name conventions (-стрит and улица + name)");
  if (coordinates.some((item) => item.mark !== "′" || !item.canonicalSpacing))
    warnings.push("Non-canonical coordinate minute marks or spacing");
  return {
    warnings,
    checks: {
      quotes,
      yo: { documents: yoDocuments, windows: yoWindows },
      capitalizedNameClusters: nameClusters(text),
      streetSuffixes: { hyphenStreet, wordStreet },
      coordinates,
    },
  };
}

export const russianLanguage: LanguageModule = {
  tag: "ru",
  target: {
    promptRules: `Russian rules:
- Use ё consistently where standard spelling requires it.
- Use «ёлочки» with nested „лапки“.
- Transliterate personal and ship names unless an established canonical form or explicit glossary entry requires otherwise.
- Never mix translation and transliteration strategies for the same entity.
- Render English street names consistently as a transliterated name plus -стрит (for example, Oxford Street → Оксфорд-стрит) unless an established canonical form requires otherwise.
- Punctuate spoken dialogue with a paragraph-opening dash, never with «ёлочки»: — Реплика, — сказал он. — Ещё реплика. This is the convention for the whole book; a segment that renders speech in quotation marks is wrong even when it is internally consistent.
- Reserve «ёлочки» for what is not spoken aloud: quoted writing, titles, unspoken thought, and a quotation inside a line of speech.
- Attribution after the speech takes a comma and a dash, never a colon: — Реплика, — сказал он. A colon introduces speech only when the attribution comes first.
- Give each speaker's turn its own paragraph, and close every «ёлочка» you open, including after an ellipsis: «Ворон…».`,
    promptStyle: {
      yo: "Use ё consistently where standard Russian spelling requires it.",
      quotes: "Use «ёлочки» and nested „лапки“ consistently.",
    },
    nameEndings: ["ою", "ею", "ой", "ей", "ом", "ем", "ём", "а", "я", "е", "и", "ы", "у", "ю"],
    script: "cyrillic",
    normalizeConsistency: normalizeRussianConsistencyMechanics,
    diagnoseConsistency: diagnoseRussianConsistency,
    isNumberWrittenOut: isRussianNumberWrittenOut,
    auditEpub: auditRussianEpub,
    loadAgreementFixes: agreementFixes,
  },
};
