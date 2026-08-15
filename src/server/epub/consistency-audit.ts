import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { extractEpub } from "./extract.js";
import { parseContainer, parsePackage } from "./package-parser.js";
import { resolveEpubPath } from "./validate.js";
import { localName, parseXml } from "./xml-dom.js";
import { agreementFixes, type AgreementFinding } from "./morphology.js";

type AuditDocument = {
  id: string;
  text: string;
  lang?: string;
  xmlLang?: string;
};

const stemWordPattern = /[\p{L}\p{M}]{4,}/gu;

/**
 * Separators that mark deliberate repetition rather than corruption: «далеко-далеко»,
 * «остатки … остатки», «поверхностей — поверхностей» are all the author's, and the source
 * is not available here to prove it, so the punctuation has to speak for them.
 */
const rhetoricalSeparator = /[-–—…]|\.\.\./u;

/**
 * Two sentences, not one fragment: «…проблемами обиды Лилит. Лилит знала лучше» is ordinary
 * prose that happens to name the same person on both sides of a full stop.
 */
// Newlines separate block nodes in the extracted audit text. A heading ending in «ИЗДАНИЙ»
// followed by a paragraph beginning «Издание…» is not a duplicated fragment.
const sentenceBreak = /[.!?\r\n]/u;

/** Two words are the same word only if they differ in an ending, not in most of the stem. */
const MIN_STEM_SHARE = 0.8;

/**
 * Adjacent words sharing a stem — "В пустыне пустыня", "Из земли Земля". Repairing a
 * fragmented heading one span at a time produced exactly this shape.
 */
export function duplicatedFragments(text: string): string[] {
  const words = [...text.toLocaleLowerCase().matchAll(stemWordPattern)];
  const found: string[] = [];
  for (let index = 1; index < words.length; index++) {
    const previous = words[index - 1];
    const current = words[index];
    const between = text.slice((previous.index ?? 0) + previous[0].length, current.index ?? 0);
    if (/[\p{L}\p{N}]/u.test(between) || rhetoricalSeparator.test(between)) continue;
    // A full stop between them ends the argument whether or not the endings agree. Picking
    // a word up across the break is a figure Russian prose uses on purpose — «Ничто из
    // этого не имело значения. Значение имела кровь» — and the last block of a paragraph
    // meets the first word of the next one the same way. Ten of one book's twelve audit
    // warnings were this, and not one was corruption.
    if (sentenceBreak.test(between)) continue;
    // The same lowercase word twice is emphasis, not corruption: «очень очень», «давай
    // давай», «тихо тихо» are how Russian intensifies — with or without a comma between —
    // and they outnumbered the real findings 53 to 3. A doubled name may likewise be a
    // deliberate vocative ("Danny, Danny" in a production source), so target-only evidence
    // cannot call identical words corruption. Different endings from fragmented reinsertion
    // («земле земля») remain actionable.
    if (previous[0] === current[0]) continue;
    // «друг друга» is one reciprocal pronoun that happens to be spelt as two declined words.
    if (previous[0] === "друг") continue;
    let common = 0;
    while (
      common < Math.min(previous[0].length, current[0].length) &&
      previous[0][common] === current[0][common]
    ) {
      common++;
    }
    // A shared four-letter prefix alone matched «в конце концов» and «провести проверку»;
    // requiring the shared part to dominate the longer word keeps «В пустыне пустыня».
    if (common >= 4 && common / Math.max(previous[0].length, current[0].length) >= MIN_STEM_SHARE)
      found.push(`${previous[0]} ${current[0]}`);
  }
  return [...new Set(found)];
}

/**
 * A table-of-contents label is a single short phrase: a repeated stem in it is corruption,
 * even when the repeats are not adjacent ("… ночи Эпилог Ночи").
 *
 * Except when the label simply says the same word twice, which chapter titles do on purpose —
 * "Wednesday, April 21, Miami — Praxis Seizure: Miami" names the city as the setting and
 * again in the title, and a faithful translation keeps both. What corruption leaves behind is
 * a repeat that is not the same word twice, or one glued directly to itself.
 */
export function repeatedStems(text: string): string[] {
  const words = [...text.toLocaleLowerCase().matchAll(stemWordPattern)];
  const stems = new Map<string, number[]>();
  words.forEach((word, index) => {
    const stem = word[0].slice(0, 5);
    stems.set(stem, [...(stems.get(stem) ?? []), index]);
  });
  const spelling = (index: number) => {
    const start = words[index].index ?? 0;
    return text.slice(start, start + words[index][0].length);
  };
  const found: string[] = [];
  for (const positions of stems.values()) {
    if (positions.length < 2) continue;
    const identical = new Set(positions.map(spelling)).size === 1;
    const adjacent = positions.some(
      (position, index) => index > 0 && position === positions[index - 1] + 1,
    );
    if (identical && !adjacent) continue;
    found.push(positions.map((index) => words[index][0]).join(" "));
  }
  return found;
}

const capitalizedWordPattern = /(?<![\p{L}\p{N}])[А-ЯЁ][а-яё]{2,}/gu;
const russianStopWords = new Set([
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

/**
 * Guillemets do not pair one-for-one in Russian: multi-paragraph direct speech reopens with
 * « in every paragraph and closes once at the end. Counting « against » calls that a defect
 * and misses the real one — a » that closes nothing. Paragraphs are separated by newlines.
 */
export function guillemetBalance(text: string) {
  let depth = 0,
    unmatchedClosings = 0,
    continuations = 0;
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

export function distance(left: string, right: string) {
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

export function nameClusters(text: string) {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(capitalizedWordPattern)) {
    const word = match[0];
    const preceding = text.slice(0, match.index).trimEnd().at(-1);
    if (russianStopWords.has(word) || !preceding || /[.!?]/u.test(preceding)) continue;
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
        distance(word.toLocaleLowerCase(), candidate.toLocaleLowerCase()) <= 2
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

export function analyzeEpubConsistency(
  documents: AuditDocument[],
  packageLanguage: string | undefined,
  expectedLanguage = "ru",
  tocLabels: string[] = [],
  /** From `morphology.ts`, which needs an optional package and an async load of its own. */
  agreement: AgreementFinding[] = [],
) {
  const text = documents.map((document) => document.text).join("\n");
  const quoteDocuments = documents.map((document) => ({
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
  const coordinateMatches = [...text.matchAll(/(\d{1,3})\s*°(\s*)(\d{1,2})(\s*)([′´'])/gu)].map(
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
  const languageDocuments = documents.map((document) => ({
    id: document.id,
    lang: document.lang,
    xmlLang: document.xmlLang,
    matches:
      document.lang?.toLocaleLowerCase().startsWith(expectedLanguage) === true &&
      (!document.xmlLang || document.xmlLang.toLocaleLowerCase().startsWith(expectedLanguage)),
  }));
  const warnings: string[] = [];
  for (const quotes of quoteDocuments) {
    if (quotes.unmatchedOpenings || quotes.unmatchedClosings)
      warnings.push(
        `${quotes.id}: unbalanced guillemets, ${quotes.unmatchedOpenings} unclosed and ${quotes.unmatchedClosings} unopened`,
      );
    if (quotes.straight) warnings.push(`${quotes.id}: ${quotes.straight} straight double quote(s)`);
  }
  if (yoDocuments.some((document) => document.cyrillicWords >= 100 && document.yo === 0))
    warnings.push("Possible ё drift: a substantial Russian document contains no ё");
  if (
    (text.match(/ё/giu)?.length ?? 0) >= 3 &&
    yoWindows.some((window) => window.cyrillicWords >= 300 && window.yo === 0)
  )
    warnings.push("Possible ё drift: a 4000-character Russian window contains no ё");
  const clusters = nameClusters(text);
  // Fuzzy target-only name clusters are diagnostic evidence, not a warning by themselves.
  // Inflections and unrelated short names routinely land within two edits of one another.
  // Morphology is likewise diagnostic. Even when it can derive a replacement, sentence
  // context may show that the adjective governs this noun or describes a person of another
  // gender. Keep the candidates and proposed forms in checks for review, but do not inflate
  // the job's warning count with them.
  const emptyDocuments = documents.filter((document) => !document.text.trim()).map((d) => d.id);
  for (const id of emptyDocuments) warnings.push(`${id}: translated document is empty`);
  const duplicates = documents.flatMap((document) =>
    duplicatedFragments(document.text).map((fragment) => ({ id: document.id, fragment })),
  );
  for (const duplicate of duplicates)
    warnings.push(`${duplicate.id}: duplicated fragment "${duplicate.fragment}"`);
  const toc = tocLabels.map((label) => ({ label, duplicates: repeatedStems(label) }));
  for (const entry of toc.filter((item) => item.duplicates.length))
    warnings.push(`Table of contents entry is corrupted: "${entry.label}"`);
  const emptyTocLabels = tocLabels.filter((label) => !label.trim()).length;
  if (emptyTocLabels) warnings.push(`${emptyTocLabels} empty table-of-contents label(s)`);
  const streetStem = (value: string) => value.toLocaleLowerCase().slice(0, 5);
  const hyphenStreetStems = new Set(hyphenStreet.map(streetStem));
  if (wordStreet.some((value) => hyphenStreetStems.has(streetStem(value))))
    warnings.push("Mixed Russian street-name conventions (-стрит and улица + name)");
  if (
    coordinateMatches.some((coordinate) => coordinate.mark !== "′" || !coordinate.canonicalSpacing)
  )
    warnings.push("Non-canonical coordinate minute marks or spacing");
  if (!packageLanguage?.toLocaleLowerCase().startsWith(expectedLanguage))
    warnings.push(
      `Package language is ${packageLanguage ?? "missing"}, expected ${expectedLanguage}`,
    );
  if (languageDocuments.some((document) => !document.matches))
    warnings.push("One or more XHTML lang/xml:lang values do not match the target language");
  return {
    version: 1,
    expectedLanguage,
    warnings,
    checks: {
      quotes: quoteDocuments,
      yo: { documents: yoDocuments, windows: yoWindows },
      capitalizedNameClusters: clusters,
      agreement,
      duplicatedFragments: duplicates,
      emptyDocuments,
      tableOfContents: toc,
      streetSuffixes: { hyphenStreet, wordStreet },
      coordinates: coordinateMatches,
      language: { packageLanguage, documents: languageDocuments },
    },
  };
}

export async function auditExtractedEpub(root: string, expectedLanguage = "ru") {
  const container = await readFile(join(root, "META-INF/container.xml"), "utf8");
  const packagePath = parseContainer(container);
  const packageFile = resolveEpubPath(root, packagePath);
  const pkg = parsePackage(await readFile(packageFile, "utf8"), packagePath);
  const documents: AuditDocument[] = [];
  const tocLabels: string[] = [];
  for (const [id, item] of pkg.manifest) {
    if (/x-dtbncx/i.test(item.mediaType)) {
      // The NCX navMap is the authoritative source for table-of-contents labels.
      const ncx = parseXml(
        await readFile(resolveEpubPath(root, item.href, posix.dirname(packagePath))),
      );
      const collect = (node: any) => {
        if (node.nodeType === 1 && localName(node) === "navLabel")
          tocLabels.push((node.textContent ?? "").replace(/\s+/g, " ").trim());
        for (let child = node.firstChild; child; child = child.nextSibling) collect(child);
      };
      collect(ncx.documentElement);
      continue;
    }
    if (!/xhtml|html/i.test(item.mediaType)) continue;
    const path = resolveEpubPath(root, item.href, posix.dirname(packagePath));
    const dom = parseXml(await readFile(path));
    const html = dom.documentElement;
    if (!html) throw new Error(`XHTML document ${item.href} has no root element`);
    documents.push({
      id,
      text: html.textContent ?? "",
      lang: html.getAttribute("lang") ?? undefined,
      xmlLang: html.getAttribute("xml:lang") ?? undefined,
    });
  }
  // The whole book as one text: the analyzer's dictionaries cost more to load than to run.
  // Only surface findings for which the morphology engine can derive one unambiguous fix.
  // The broader detector remains available for diagnostics, but its dictionary ambiguity
  // produced mostly false warnings in completed books.
  const agreement = expectedLanguage.toLocaleLowerCase().startsWith("ru")
    ? await agreementFixes(documents.map((document) => document.text).join("\n"))
    : [];
  return analyzeEpubConsistency(documents, pkg.language, expectedLanguage, tocLabels, agreement);
}

export async function auditEpubArchive(archivePath: string, expectedLanguage = "ru") {
  const extracted = await mkdtemp(join(tmpdir(), "book-translator-audit-"));
  try {
    await extractEpub(archivePath, extracted);
    return await auditExtractedEpub(extracted, expectedLanguage);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}
