import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { distance } from "../epub/consistency-audit.js";
import type { TextSegment } from "../epub/text-segments.js";
import type {
  LanguageModelProvider,
  ProviderLanguage,
  ProviderProfile,
  ProviderSegment,
} from "../providers/provider.js";

const CONSISTENCY_VERSION = 4;
/** One resolver request per this many entities. One big request timed out and lost everything. */
export const CONSISTENCY_CHUNK_SIZE = 25;

export type ConsistencyDocument = {
  id: string;
  sourceSegments: TextSegment[];
  editedSegments: ProviderSegment[];
};

export type EntityEvidence = {
  source: string;
  occurrences: number;
  contexts: Array<{ source: string; target?: string }>;
};

export type GlossaryEntry = {
  id: string;
  source: string;
  target: string;
  category: string;
  note?: string;
  enabled: boolean;
};

export function isGlossaryEntry(value: unknown): value is GlossaryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "source" in value &&
    typeof value.source === "string" &&
    "target" in value &&
    typeof value.target === "string" &&
    "category" in value &&
    typeof value.category === "string" &&
    "enabled" in value &&
    typeof value.enabled === "boolean"
  );
}

export function mergeGlossaries(userEntries: unknown[], generatedEntries: GlossaryEntry[]) {
  const userSources = new Set(
    userEntries.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || !("source" in entry)) return [];
      return typeof entry.source === "string" ? [entry.source.toLocaleLowerCase()] : [];
    }),
  );
  return [
    ...userEntries,
    ...generatedEntries.filter((entry) => !userSources.has(entry.source.toLocaleLowerCase())),
  ];
}

const registrySchema = z.object({
  entries: z.array(
    z.object({
      source: z.string().min(2),
      target: z.string().min(1),
      category: z.enum(["person", "place", "ship", "organization", "work", "term", "other"]),
      strategy: z.string().optional(),
    }),
  ),
});

const resolutionSchema = z.object({
  decisions: z.array(
    z.object({
      source: z.string().min(2),
      canonical: z.string().min(1),
      variants: z.array(z.string().min(1)),
    }),
  ),
});

const sourceNamePattern = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}'’.-]{2,}/gu;
const sourcePlacePattern =
  /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}'’-]{2,}\s+(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Lane|Square|Place)(?![\p{L}\p{N}])/gu;
const wordPattern = /[\p{L}\p{M}]*[её][\p{L}\p{M}]*/giu;
// A capitalized word is not an entity just because a sentence started with it. The registry
// spent a production run resolving "She" and "The"; that noise is what timed the resolver out.
const sourceStopWords = new Set(
  `a an the this that these those he she it they we you i me him her them us my your his hers its
   their our mine yours ours theirs myself himself herself itself themselves who whom whose which
   what when where why how while then there here now once again always never ever still just only
   very too also even both each few more most other some any all such than as at by in on to of off
   out up down over under about above below between through during against for from into onto upon
   with without within toward towards after before behind beside besides beyond near since until
   unless because although though however therefore moreover meanwhile nevertheless otherwise
   and but or nor so yet if else is are was were be been being am have has had having do does did
   will would shall should can could may might must let lets need dare used
   yes no not oh ah ay well now good great sure right okay
   one two three four five six seven eight nine ten first second third last next
   said says say tell told asked answered replied cried thought knew know
   chapter part book volume section epilogue prologue appendix contents introduction preface
   project gutenberg ebook copyright
   professor doctor mister missus madam madame sir lord lady captain colonel major general
   street st avenue ave road rd lane square place drive court`
    .split(/\s+/)
    .filter(Boolean),
);
const lowercaseWordPattern = /(?<![\p{L}\p{N}])\p{Ll}[\p{L}\p{M}'’-]{2,}/gu;

function clipped(value: string, max = 320) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readCache<T>(
  path: string,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8"));
    if (cached.key !== key) return undefined;
    return schema.parse(cached.value);
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, key: string, value: unknown) {
  await writeFile(path, JSON.stringify({ key, value }, null, 2));
}

export type EntityEvidenceStats = {
  candidates: number;
  stopWords: number;
  commonWords: number;
  weakEvidence: number;
  overflow: number;
  kept: number;
};

export function extractRepeatedSourceEntities(documents: ConsistencyDocument[]): EntityEvidence[] {
  return extractEntityEvidence(documents).entities;
}

export function extractEntityEvidence(documents: ConsistencyDocument[]): {
  entities: EntityEvidence[];
  stats: EntityEvidenceStats;
} {
  // A word that also occurs lowercase somewhere in the book is a common word, not a name.
  const lowercaseWords = new Set<string>();
  for (const document of documents)
    for (const segment of document.sourceSegments)
      for (const match of segment.text.matchAll(lowercaseWordPattern))
        lowercaseWords.add(match[0].toLocaleLowerCase());
  const stats: EntityEvidenceStats = {
    candidates: 0,
    stopWords: 0,
    commonWords: 0,
    weakEvidence: 0,
    overflow: 0,
    kept: 0,
  };
  const found = new Map<
    string,
    {
      source: string;
      occurrences: number;
      nonInitialOccurrences: number;
      isolatedOccurrences: number;
      highConfidence: boolean;
      contexts: Array<{ source: string; target?: string }>;
    }
  >();
  for (const document of documents) {
    const edited = new Map(document.editedSegments.map((segment) => [segment.id, segment.text]));
    for (const segment of document.sourceSegments) {
      const candidates = [
        ...[...segment.text.matchAll(sourcePlacePattern)].map((match) => ({
          match,
          highConfidence: true,
        })),
        ...[...segment.text.matchAll(sourceNamePattern)].map((match) => ({
          match,
          highConfidence: false,
        })),
      ];
      for (const { match, highConfidence } of candidates) {
        const source = match[0]
          .replace(/[.-]+$/u, "")
          .trim()
          .replace(/\s+/gu, " ");
        const key = source.toLocaleLowerCase();
        if (!found.has(key)) stats.candidates++;
        if (sourceStopWords.has(key)) {
          if (!found.has(key)) stats.stopWords++;
          continue;
        }
        // Multi-word matches (place patterns) never appear as a single lowercase token.
        if (!key.includes(" ") && lowercaseWords.has(key)) {
          if (!found.has(key)) stats.commonWords++;
          continue;
        }
        const entry = found.get(key) ?? {
          source,
          occurrences: 0,
          nonInitialOccurrences: 0,
          isolatedOccurrences: 0,
          highConfidence: false,
          contexts: [],
        };
        entry.occurrences++;
        entry.highConfidence ||= highConfidence;
        const preceding = segment.text.slice(0, match.index).trimEnd().at(-1);
        if (preceding && !/[.!?]/u.test(preceding)) entry.nonInitialOccurrences++;
        const withoutCandidate = `${segment.text.slice(0, match.index)}${segment.text.slice(
          (match.index ?? 0) + match[0].length,
        )}`.replace(/[\s"'«»„“”()[\].,:;!?—-]/gu, "");
        if (!withoutCandidate) entry.isolatedOccurrences++;
        if (entry.contexts.length < 8) {
          entry.contexts.push({ source: clipped(segment.text), target: edited.get(segment.id) });
        }
        found.set(key, entry);
      }
    }
  }
  const strong = [...found.values()].filter(
    (entry) =>
      entry.highConfidence ||
      (entry.occurrences >= 2 &&
        (entry.nonInitialOccurrences > 0 || entry.isolatedOccurrences > 0)),
  );
  stats.weakEvidence = found.size - strong.length;
  const ranked = strong
    .map(
      ({
        nonInitialOccurrences: _nonInitialOccurrences,
        isolatedOccurrences: _isolatedOccurrences,
        highConfidence: _highConfidence,
        ...entry
      }) => entry,
    )
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences || left.source.localeCompare(right.source),
    );
  const entities = ranked.slice(0, 250);
  stats.overflow = ranked.length - entities.length;
  stats.kept = entities.length;
  return { entities, stats };
}

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

export function normalizeRussianConsistencyMechanics(documents: ConsistencyDocument[]) {
  let applied = 0;
  const rules: Array<[RegExp, (...values: string[]) => string]> = [
    [
      /(\d{1,3})\s*°\s*(\d{1,2})\s*[′´']/gu,
      (_match, degrees, minutes) => `${degrees}° ${minutes}′`,
    ],
    [/"\s*([^"\n]{1,240}?)\s*»/gu, (_match, content) => `«${content.trim()}»`],
    [/«\s*([^«\n]{1,240}?)\s*"/gu, (_match, content) => `«${content.trim()}»`],
    [/"\s*([^"\n]{1,240}?)\s*"/gu, (_match, content) => `«${content.trim()}»`],
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

function quoteReport(text: string) {
  const opening = text.match(/«/g)?.length ?? 0;
  const closing = text.match(/»/g)?.length ?? 0;
  const straight = text.match(/"/g)?.length ?? 0;
  const hybrid = text.match(/"[^"\n]{0,240}»|«[^«\n]{0,240}"/g)?.map((item) => clipped(item)) ?? [];
  const duplicated = text.match(/«\s*«|»\s*»/g)?.length ?? 0;
  return { opening, closing, straight, balanced: opening === closing, hybrid, duplicated };
}

function yoVariants(text: string) {
  const forms = new Map<string, Set<string>>();
  for (const match of text.matchAll(wordPattern)) {
    const word = match[0].toLocaleLowerCase();
    const key = word.replaceAll("ё", "е");
    const variants = forms.get(key) ?? new Set<string>();
    variants.add(word);
    forms.set(key, variants);
  }
  return [...forms.entries()]
    .filter(([, variants]) => variants.size > 1 && [...variants].some((word) => word.includes("ё")))
    .map(([key, variants]) => ({ key, variants: [...variants].sort() }));
}

export function buildConsistencyReport(
  documents: ConsistencyDocument[],
  glossary: GlossaryEntry[] = [],
) {
  const evidence = extractEntityEvidence(documents);
  const entityEvidence = evidence.entities.map((entity) => ({
    ...entity,
    expectedTarget: glossary.find(
      (entry) =>
        entry.enabled && entry.source.toLocaleLowerCase() === entity.source.toLocaleLowerCase(),
    )?.target,
  }));
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
  return {
    version: 1,
    entityEvidence,
    entityStats: evidence.stats,
    documents: documentReports,
    warningCount,
  };
}

async function completeJsonTask(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  id: string,
  payload: unknown,
  signal?: AbortSignal,
) {
  const response = await provider.complete(
    {
      profile,
      mode: "consistency",
      sourceLanguage,
      targetLanguage,
      segments: [{ id, text: JSON.stringify(payload) }],
    },
    signal,
  );
  return JSON.parse(response.segments[0]?.text ?? "");
}

export async function resolveEntityRegistry(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  documents: ConsistencyDocument[],
  root: string,
  signal?: AbortSignal,
): Promise<GlossaryEntry[]> {
  const entities = extractRepeatedSourceEntities(documents).map(
    ({ source, occurrences, contexts }) => ({
      source,
      occurrences,
      contexts: contexts.map((context) => context.source),
    }),
  );
  if (!entities.length) return [];
  const payload = { task: "entity_registry", entities };
  const key = stableHash({
    version: CONSISTENCY_VERSION,
    payload,
    model: profile.model,
    targetLanguage,
  });
  const path = `${root}/entity-registry.json`;
  const cached = await readCache(path, key, registrySchema);
  const value =
    cached ??
    registrySchema.parse(
      await completeJsonTask(
        provider,
        profile,
        sourceLanguage,
        targetLanguage,
        "entity-registry",
        payload,
        signal,
      ),
    );
  if (!cached) await writeCache(path, key, value);
  const allowed = new Set(entities.map((entity) => entity.source.toLocaleLowerCase()));
  return value.entries
    .filter((entry) => allowed.has(entry.source.toLocaleLowerCase()))
    .map((entry, index) => ({
      id: `generated-entity-${index + 1}`,
      source: entry.source,
      target: entry.target,
      category: entry.category,
      note: entry.strategy,
      enabled: true,
    }));
}

export type ConsistencyResolution = {
  decisions: z.infer<typeof resolutionSchema>["decisions"];
  chunks: number;
  resolvedChunks: number;
  failedChunks: Array<{ chunk: number; error: string }>;
};

const resolutionCacheSchema = z.object({
  version: z.number(),
  chunks: z.record(z.string(), resolutionSchema),
});

/**
 * Resolve terminology conflicts in bounded chunks. Each chunk is its own request with its
 * own cache entry, written as soon as it succeeds: a timeout in chunk 7 keeps chunks 1-6,
 * which is exactly what the single-request version threw away.
 */
export async function resolveConsistencyConflicts(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  report: ReturnType<typeof buildConsistencyReport>,
  root: string,
  signal?: AbortSignal,
  chunkSize = CONSISTENCY_CHUNK_SIZE,
): Promise<ConsistencyResolution> {
  const path = `${root}/consistency-resolution.json`;
  const cache = (await readCache(path, String(CONSISTENCY_VERSION), resolutionCacheSchema)) ?? {
    version: CONSISTENCY_VERSION,
    chunks: {},
  };
  const groups: (typeof report.entityEvidence)[] = [];
  for (let offset = 0; offset < report.entityEvidence.length; offset += chunkSize)
    groups.push(report.entityEvidence.slice(offset, offset + chunkSize));
  const decisions: ConsistencyResolution["decisions"] = [];
  const failedChunks: ConsistencyResolution["failedChunks"] = [];
  let resolvedChunks = 0;
  for (const [index, entityEvidence] of groups.entries()) {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    const payload = {
      task: "resolve_conflicts",
      report: { ...report, entityEvidence, documents: [] },
    };
    const chunkKey = stableHash({ payload, model: profile.model, targetLanguage });
    let value = cache.chunks[chunkKey];
    if (!value) {
      try {
        value = resolutionSchema.parse(
          await completeJsonTask(
            provider,
            profile,
            sourceLanguage,
            targetLanguage,
            `consistency-resolution-${index + 1}`,
            payload,
            signal,
          ),
        );
        cache.chunks[chunkKey] = value;
        await writeCache(path, String(CONSISTENCY_VERSION), cache);
      } catch (error) {
        if (signal?.aborted) throw error;
        failedChunks.push({
          chunk: index + 1,
          error: error instanceof Error ? error.message : "unknown error",
        });
        continue;
      }
    }
    resolvedChunks++;
    decisions.push(...value.decisions);
  }
  return { decisions, chunks: groups.length, resolvedChunks, failedChunks };
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceVariants(documents: ConsistencyDocument[], replacements: Map<string, string>) {
  let applied = 0;
  for (const document of documents) {
    for (const segment of document.editedSegments) {
      for (const [variant, canonical] of replacements) {
        const isWordLike = /^[\p{L}\p{N}].*[\p{L}\p{N}]$/u.test(variant);
        const pattern = new RegExp(
          `${isWordLike ? "(?<![\\p{L}\\p{N}])" : ""}${escapedPattern(variant)}${
            isWordLike ? "(?![\\p{L}\\p{N}])" : ""
          }`,
          "gu",
        );
        segment.text = segment.text.replace(pattern, () => {
          applied++;
          return canonical;
        });
      }
    }
  }
  return applied;
}

const capitalizedTargetWord = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}'’-]{2,}/gu;

/**
 * A near-match is an inflection, not a spelling variant, when the two forms agree on
 * everything but their ending: Кира/Киры is one name, Кира/Кайра is two.
 */
function isInflection(left: string, right: string) {
  let common = 0;
  while (
    common < Math.min(left.length, right.length) &&
    left[common].toLocaleLowerCase() === right[common].toLocaleLowerCase()
  ) {
    common++;
  }
  return common >= Math.min(left.length, right.length) - 2;
}

/**
 * Deterministic fallback for when the resolver model is unavailable or times out. Anchored
 * on the glossary: only forms that are near-identical to a canonical target and differ in
 * their stem are replaced, so Кира collapses into Кайра while Киры is left alone.
 */
export function alignGlossaryVariants(
  documents: ConsistencyDocument[],
  glossary: GlossaryEntry[],
): { applied: number; replacements: Array<{ variant: string; canonical: string }> } {
  const canonicalTargets = glossary
    .filter((entry) => entry.enabled && entry.target.trim().length >= 4)
    .map((entry) => entry.target.trim())
    .filter((target) => /^\p{Lu}[\p{L}\p{M}'’-]+$/u.test(target));
  if (!canonicalTargets.length) return { applied: 0, replacements: [] };
  const canonicalSet = new Set(canonicalTargets);
  const words = new Set<string>();
  for (const document of documents)
    for (const segment of document.editedSegments)
      for (const match of segment.text.matchAll(capitalizedTargetWord)) words.add(match[0]);
  const replacements = new Map<string, string>();
  for (const word of words) {
    if (canonicalSet.has(word)) continue;
    const canonical = canonicalTargets.find(
      (target) =>
        Math.abs(target.length - word.length) <= 2 &&
        distance(target.toLocaleLowerCase(), word.toLocaleLowerCase()) <= 2 &&
        !isInflection(target, word),
    );
    if (canonical) replacements.set(word, canonical);
  }
  return {
    applied: replaceVariants(documents, replacements),
    replacements: [...replacements].map(([variant, canonical]) => ({ variant, canonical })),
  };
}

export function applyConsistencyDecisions(
  documents: ConsistencyDocument[],
  decisions: z.infer<typeof resolutionSchema>["decisions"],
) {
  const alignedTargets = new Map<string, string[]>();
  for (const document of documents) {
    const edited = new Map(document.editedSegments.map((segment) => [segment.id, segment.text]));
    for (const sourceSegment of document.sourceSegments) {
      for (const decision of decisions) {
        if (
          !sourceSegment.text
            .replace(/\s+/gu, " ")
            .toLocaleLowerCase()
            .includes(decision.source.toLocaleLowerCase())
        ) {
          continue;
        }
        const values = alignedTargets.get(decision.source.toLocaleLowerCase()) ?? [];
        const target = edited.get(sourceSegment.id);
        if (target) values.push(target);
        alignedTargets.set(decision.source.toLocaleLowerCase(), values);
      }
    }
  }
  const replacements = new Map<string, string>();
  for (const decision of decisions) {
    const evidence = alignedTargets.get(decision.source.toLocaleLowerCase()) ?? [];
    for (const variant of decision.variants) {
      if (
        variant !== decision.canonical &&
        variant.length >= 2 &&
        evidence.some((text) => text.includes(variant)) &&
        !replacements.has(variant)
      ) {
        replacements.set(variant, decision.canonical);
      }
    }
  }
  return replaceVariants(documents, replacements);
}
