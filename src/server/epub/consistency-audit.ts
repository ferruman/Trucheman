import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { extractEpub } from "./extract.js";
import { parseContainer, parsePackage } from "./package-parser.js";
import { resolveEpubPath } from "./validate.js";
import { parseXml } from "./xml-dom.js";

type AuditDocument = {
  id: string;
  text: string;
  lang?: string;
  xmlLang?: string;
};

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

function distance(left: string, right: string) {
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
) {
  const text = documents.map((document) => document.text).join("\n");
  const quoteDocuments = documents.map((document) => ({
    id: document.id,
    opening: document.text.match(/«/gu)?.length ?? 0,
    closing: document.text.match(/»/gu)?.length ?? 0,
    straight: document.text.match(/"/gu)?.length ?? 0,
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
    if (quotes.opening !== quotes.closing)
      warnings.push(`${quotes.id}: unbalanced guillemets ${quotes.opening}/${quotes.closing}`);
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
  if (clusters.length) warnings.push(`${clusters.length} possible capitalized-name cluster(s)`);
  if (hyphenStreet.length && wordStreet.length)
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
  for (const [id, item] of pkg.manifest) {
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
  return analyzeEpubConsistency(documents, pkg.language, expectedLanguage);
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
