import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { distance, guillemetBalance } from "../epub/consistency-audit.js";
import { atomicJson } from "../storage/atomic-file.js";
import type { TextSegment } from "../epub/text-segments.js";
import type {
  LanguageModelProvider,
  ProviderLanguage,
  ProviderProfile,
  ProviderSegment,
} from "../providers/provider.js";

/**
 * Layout of the on-disk answer caches. This is not a lever for re-asking the model: bumping
 * it discards decisions the book already depends on. Bump it only when the file shape below
 * changes, and re-resolve a job through its invalidation instead.
 */
const CONSISTENCY_CACHE_FORMAT = 1;
const CONSISTENCY_CACHE_KEY = `entity-answers-v${CONSISTENCY_CACHE_FORMAT}`;
/** One model request per this many entities. One big request timed out and lost everything. */
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
/** Lowercase words that stay inside a name: Little Chapel of the Stars. */
const nameConnectors = new Set(["of", "the", "de", "del", "la", "le", "van", "von", "der", "du"]);
const tokenPattern = /[\p{L}\p{N}\p{M}'’-]+/gu;

/**
 * Runs of capitalized words — the only way a multi-word entity ever becomes one candidate.
 * Matching single words alone reduced "Leticia Dreams the Truth Hardin" to four unrelated
 * ones, so the registry's answer for the whole name was discarded as unsupported and the
 * phrase went through the book in four different renderings.
 */
export function capitalizedPhrases(text: string, maxWords = 5) {
  const tokens = [...text.matchAll(tokenPattern)];
  const phrases: Array<{ value: string; index: number }> = [];
  const emit = (start: number, end: number) => {
    // Trim leading stop words: "Then Kyra" is a sentence opening, not a name.
    while (start < end && sourceStopWords.has(tokens[start][0].toLocaleLowerCase())) start++;
    while (end > start && sourceStopWords.has(tokens[end][0].toLocaleLowerCase())) end--;
    if (end <= start || end - start + 1 > maxWords) return;
    const from = tokens[start].index ?? 0;
    const to = (tokens[end].index ?? 0) + tokens[end][0].length;
    phrases.push({ value: text.slice(from, to), index: from });
  };
  let start = -1,
    lastCapital = -1;
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    // Anything but whitespace between two words ends the run: "Johnny Church. Kyra" is two.
    const separated =
      !previous ||
      !/^[ \t]+$/u.test(text.slice((previous.index ?? 0) + previous[0].length, token.index));
    if (/^\p{Lu}/u.test(token[0])) {
      if (separated && start >= 0) emit(start, lastCapital);
      if (separated || start < 0) start = index;
      lastCapital = index;
      continue;
    }
    // A connector bridges only when a capitalized word follows it, possibly past further
    // connectors: Little Chapel *of the* Stars.
    let ahead = index;
    while (
      !separated &&
      start >= 0 &&
      nameConnectors.has(tokens[ahead][0].toLocaleLowerCase()) &&
      tokens[ahead + 1] !== undefined &&
      /^[ \t]+$/u.test(
        text.slice((tokens[ahead].index ?? 0) + tokens[ahead][0].length, tokens[ahead + 1].index),
      )
    ) {
      ahead++;
      if (/^\p{Lu}/u.test(tokens[ahead][0])) break;
    }
    if (ahead > index && /^\p{Lu}/u.test(tokens[ahead][0])) continue;
    if (start >= 0) emit(start, lastCapital);
    start = -1;
    lastCapital = -1;
  }
  if (start >= 0) emit(start, lastCapital);
  return phrases.filter((phrase) => /\s/u.test(phrase.value));
}

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
  await atomicJson(path, { key, value });
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
          value: match[0],
          index: match.index ?? 0,
          highConfidence: true,
        })),
        ...capitalizedPhrases(segment.text).map((phrase) => ({ ...phrase, highConfidence: false })),
        ...[...segment.text.matchAll(sourceNamePattern)].map((match) => ({
          value: match[0],
          index: match.index ?? 0,
          highConfidence: false,
        })),
      ];
      for (const { value, index, highConfidence } of candidates) {
        // Kyra’s is Kyra. Keeping them apart split one entity's evidence in two and spent
        // two of the candidate slots on it.
        const source = value
          .replace(/['’]s$/iu, "")
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
        const preceding = segment.text.slice(0, index).trimEnd().at(-1);
        if (preceding && !/[.!?]/u.test(preceding)) entry.nonInitialOccurrences++;
        const withoutCandidate = `${segment.text.slice(0, index)}${segment.text.slice(
          index + value.length,
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
    // «A», — сказал X. — B». One line of speech interrupted by its attribution needs one
    // pair of guillemets around the whole line, not a pair that closes and never reopens.
    // This is the single largest source of unmatched » in a translated dialogue scene.
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

export type ChunkedRun = { chunks: number; resolvedChunks: number; failedChunks: ChunkFailure[] };
export type ChunkFailure = { chunk: number; error: string };
export type EntityRegistry = ChunkedRun & { entries: GlossaryEntry[] };

const answeredSchema = z.object({
  format: z.literal(CONSISTENCY_CACHE_FORMAT),
  entities: z.record(z.string(), z.array(z.object({ source: z.string() }).passthrough())),
});

/**
 * Ask the model about a set of entities, in bounded chunks, remembering its answer per
 * entity.
 *
 * Per entity, not per request, and deliberately not keyed on the code version or the model:
 * what a name is called in the translation is a decision about the book, and re-asking
 * re-rolls it. A version bump once flipped Kyra from Кайра to Кира across the whole book,
 * and because the glossary feeds the checkpoint key, that also re-spent every stage. An
 * entity whose evidence has not changed is never asked about twice; adding new entities
 * only costs the new ones. Use the job's invalidation to deliberately start over.
 */
async function completeEntityTask<Item, Answer extends { source: string }>(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  options: {
    id: string;
    path: string;
    items: Item[];
    itemSource: (item: Item) => string;
    chunkSize: number;
    parse: (value: unknown) => Answer[];
    payload: (items: Item[]) => unknown;
    signal?: AbortSignal;
  },
): Promise<ChunkedRun & { answers: Answer[] }> {
  const cache = (await readCache(options.path, CONSISTENCY_CACHE_KEY, answeredSchema)) ?? {
    format: CONSISTENCY_CACHE_FORMAT,
    entities: {} as Record<string, Array<{ source: string }>>,
  };
  const keyed = options.items.map((item) => ({
    item,
    source: options.itemSource(item).toLocaleLowerCase(),
    key: stableHash({ item, targetLanguage }),
  }));
  const pending = keyed.filter((entry) => !cache.entities[entry.key]);
  const groups: (typeof pending)[] = [];
  for (let offset = 0; offset < pending.length; offset += options.chunkSize)
    groups.push(pending.slice(offset, offset + options.chunkSize));
  const failedChunks: ChunkFailure[] = [];
  let resolvedChunks = 0;
  for (const [index, group] of groups.entries()) {
    if (options.signal?.aborted)
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
    try {
      const answers = options.parse(
        await completeJsonTask(
          provider,
          profile,
          sourceLanguage,
          targetLanguage,
          `${options.id}-${index + 1}`,
          options.payload(group.map((entry) => entry.item)),
          options.signal,
        ),
      );
      // Record an answer for every entity asked about, empty ones included, so that an
      // entity the model declined to answer is not asked about again on the next run.
      for (const entry of group)
        cache.entities[entry.key] = answers.filter(
          (answer) => answer.source.toLocaleLowerCase() === entry.source,
        );
      await writeCache(options.path, CONSISTENCY_CACHE_KEY, cache);
      resolvedChunks++;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failedChunks.push({
        chunk: index + 1,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
  const answers = keyed.flatMap((entry) => (cache.entities[entry.key] ?? []) as Answer[]);
  return { answers, chunks: groups.length, resolvedChunks, failedChunks };
}

export async function resolveEntityRegistry(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  documents: ConsistencyDocument[],
  root: string,
  signal?: AbortSignal,
  chunkSize = CONSISTENCY_CHUNK_SIZE,
): Promise<EntityRegistry> {
  const entities = extractRepeatedSourceEntities(documents).map(
    ({ source, occurrences, contexts }) => ({
      source,
      occurrences,
      contexts: contexts.map((context) => context.source),
    }),
  );
  if (!entities.length) return { entries: [], chunks: 0, resolvedChunks: 0, failedChunks: [] };
  const { answers, ...run } = await completeEntityTask(
    provider,
    profile,
    sourceLanguage,
    targetLanguage,
    {
      id: "entity-registry",
      path: `${root}/entity-registry.json`,
      items: entities,
      itemSource: (entity) => entity.source,
      chunkSize,
      parse: (value) => registrySchema.parse(value).entries,
      payload: (chunk) => ({ task: "entity_registry", entities: chunk }),
      signal,
    },
  );
  const allowed = new Set(entities.map((entity) => entity.source.toLocaleLowerCase()));
  const seen = new Set<string>();
  const entries: GlossaryEntry[] = [];
  for (const entry of answers) {
    const key = entry.source.toLocaleLowerCase();
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      id: `generated-entity-${entries.length + 1}`,
      source: entry.source,
      target: entry.target,
      category: entry.category,
      note: entry.strategy,
      enabled: true,
    });
  }
  return { entries, ...run };
}

export type ConsistencyResolution = ChunkedRun & {
  decisions: z.infer<typeof resolutionSchema>["decisions"];
};

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
  const { answers, ...run } = await completeEntityTask(
    provider,
    profile,
    sourceLanguage,
    targetLanguage,
    {
      id: "consistency-resolution",
      path: `${root}/consistency-resolution.json`,
      items: report.entityEvidence,
      itemSource: (entity) => entity.source,
      chunkSize,
      parse: (value) => resolutionSchema.parse(value).decisions,
      payload: (entityEvidence) => ({
        task: "resolve_conflicts",
        report: { ...report, entityEvidence, documents: [] },
      }),
      signal,
    },
  );
  return { decisions: answers, ...run };
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedPattern(variant: string) {
  const wordLike = /^[\p{L}\p{N}].*[\p{L}\p{N}]$/u.test(variant);
  const before = wordLike ? "(?<![\\p{L}\\p{N}])" : "";
  const after = wordLike ? "(?![\\p{L}\\p{N}])" : "";
  return `${before}${escapedPattern(variant)}${after}`;
}

/**
 * One pass over the text, longest variant first. A pass per variant let each replacement's
 * output be the next one's input, and a production replay walked Кайра → Кира Дэймон →
 * Кира → Кай, renaming the protagonist in all 579 of her mentions.
 */
function replaceVariants(documents: ConsistencyDocument[], replacements: Map<string, string>) {
  if (!replacements.size) return 0;
  const variants = [...replacements.keys()].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  const pattern = new RegExp(variants.map(boundedPattern).join("|"), "gu");
  let applied = 0;
  for (const document of documents) {
    for (const segment of document.editedSegments) {
      segment.text = segment.text.replace(pattern, (match) => {
        const canonical = replacements.get(match);
        if (canonical === undefined) return match;
        applied++;
        return canonical;
      });
    }
  }
  return applied;
}

function words(value: string) {
  return value.split(/\s+/u).filter(Boolean);
}

function containsWholeWord(haystack: string, needle: string) {
  return new RegExp(boundedPattern(needle), "u").test(haystack);
}

/**
 * A decision may re-spell a name; it may not rename one. The resolver routinely returns the
 * canonical's own declensions as variants, and single-word renderings as variants of the
 * full name, so applying its output literally collapsed Летиции into Летиция and truncated
 * Кира Дэймон to Кира.
 */
export function isSafeVariant(variant: string, canonical: string, nameEndings: string[] = []) {
  if (variant === canonical || variant.length < 2) return false;
  const stem = (value: string) => nameStem(value, nameEndings).toLocaleLowerCase();
  if (
    words(variant).length === 1 &&
    words(canonical).length === 1 &&
    stem(variant) === stem(canonical)
  )
    return false;
  // A first name and a full name refer differently; swapping one for the other is a rename.
  if ((words(variant).length === 1) !== (words(canonical).length === 1)) return false;
  return !containsWholeWord(variant, canonical) && !containsWholeWord(canonical, variant);
}

/**
 * A chapter title is written three times in an EPUB — the NCX navLabel, the nav document
 * link, and the heading itself — and each was translated in its own batch, so the three
 * drifted apart. One source string gets one translation, and where the NCX has a label it
 * wins: navMap is the authority for table-of-contents wording.
 */
export function alignNavigationLabels(
  documents: ConsistencyDocument[],
  roles: Map<string, "ncx" | "nav" | null>,
  maxLength = 120,
): { applied: number; labels: Array<{ source: string; canonical: string }> } {
  type Occurrence = { document: ConsistencyDocument; id: string; role: "ncx" | "nav" | null };
  const groups = new Map<string, Occurrence[]>();
  for (const document of documents) {
    const role = roles.get(document.id) ?? null;
    for (const source of document.sourceSegments) {
      const key = source.text.replace(/\s+/gu, " ").trim();
      if (!key || key.length > maxLength || !/[\p{L}]/u.test(key)) continue;
      groups.set(key, [...(groups.get(key) ?? []), { document, id: source.id, role }]);
    }
  }
  const labels: Array<{ source: string; canonical: string }> = [];
  let applied = 0;
  for (const [source, occurrences] of groups) {
    if (occurrences.length < 2 || !occurrences.some((entry) => entry.role)) continue;
    const authority =
      occurrences.find((entry) => entry.role === "ncx") ??
      occurrences.find((entry) => entry.role === "nav")!;
    const edited = (entry: Occurrence) =>
      entry.document.editedSegments.find((segment) => segment.id === entry.id);
    const canonical = edited(authority)?.text.trim();
    if (!canonical) continue;
    let changed = false;
    for (const occurrence of occurrences) {
      const segment = edited(occurrence);
      if (!segment || segment.text.trim() === canonical) continue;
      segment.text = segment.text.replace(segment.text.trim(), canonical);
      applied++;
      changed = true;
    }
    if (changed) labels.push({ source, canonical });
  }
  return { applied, labels };
}

const capitalizedTargetWord = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}'’-]{2,}/gu;
const singleNameTarget = /^\p{Lu}[\p{L}\p{M}'’-]+$/u;
/** A rendering used in under 1/VARIANT_SHARE of an entity's mentions is not that entity. */
const VARIANT_SHARE = 50;

function nameStem(word: string, endings: string[]): string {
  const lower = word.toLocaleLowerCase();
  for (const ending of endings) {
    if (ending && lower.endsWith(ending) && word.length - ending.length >= 3)
      return word.slice(0, word.length - ending.length);
  }
  return word;
}

/**
 * The translated blocks that can legitimately contain a rendering of an entity: the ones
 * whose source names it. Without this anchor a bare edit-distance search rewrites ordinary
 * target words that merely resemble a glossary name — Дети → Лети.
 */
export function glossaryEvidence(
  documents: ConsistencyDocument[],
  glossary: GlossaryEntry[],
): Map<string, string[]> {
  const patterns = glossary.map((entry) => ({
    key: entry.source.toLocaleLowerCase(),
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}])${escapedPattern(entry.source)}(?![\\p{L}\\p{N}])`,
      "iu",
    ),
  }));
  const evidence = new Map<string, string[]>(patterns.map((entry) => [entry.key, []]));
  for (const document of documents) {
    const edited = new Map(document.editedSegments.map((segment) => [segment.id, segment.text]));
    for (const segment of document.sourceSegments) {
      const target = edited.get(segment.id);
      if (!target) continue;
      for (const { key, pattern } of patterns)
        if (pattern.test(segment.text)) evidence.get(key)!.push(target);
    }
  }
  return evidence;
}

/** `needle` must already be lowercased; `haystack` is lowercased by the caller once. */
function occurrences(haystack: string, needle: string) {
  let count = 0;
  for (let index = haystack.indexOf(needle); index >= 0;) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** A capitalized form that also occurs lowercase in the book is an ordinary word, not a name. */
function lowercaseStems(documents: ConsistencyDocument[], endings: string[]) {
  const stems = new Set<string>();
  for (const document of documents)
    for (const segment of document.editedSegments)
      for (const match of segment.text.matchAll(lowercaseWordPattern))
        stems.add(nameStem(match[0].toLocaleLowerCase(), endings));
  return stems;
}

/**
 * Deterministic fallback for when the resolver model is unavailable or times out. For each
 * glossary entry it looks only at the translations of blocks that name the entity, and
 * corrects the *stem* of a near-identical form while keeping that form's case ending:
 * Летисию → Летицию, never Летисия. Кирилл, Кирове and every ordinary word are left alone.
 */
export function alignGlossaryVariants(
  documents: ConsistencyDocument[],
  glossary: GlossaryEntry[],
  nameEndings: string[] = [],
): { applied: number; replacements: Array<{ variant: string; canonical: string }> } {
  const entries = glossary.filter(
    (entry) => entry.enabled && singleNameTarget.test(entry.target.trim()),
  );
  if (!entries.length) return { applied: 0, replacements: [] };
  const evidence = glossaryEvidence(documents, entries);
  const common = lowercaseStems(documents, nameEndings);
  const stem = (word: string) => nameStem(word, nameEndings);
  const canonicalStems = new Set(
    entries.map((entry) => stem(entry.target.trim()).toLocaleLowerCase()),
  );
  const attested = new Set<string>();
  for (const document of documents)
    for (const segment of document.editedSegments)
      for (const match of segment.text.matchAll(capitalizedTargetWord)) attested.add(match[0]);
  const replacements = new Map<string, string>();
  for (const entry of entries) {
    const canonical = entry.target.trim();
    const canonicalStem = stem(canonical);
    const canonicalKey = canonicalStem.toLocaleLowerCase();
    // A three-letter stem sits at edit distance 1 from ordinary words (Лет/Дет), so an
    // entry that short cannot be aligned safely at all.
    if (canonicalStem.length < 4) continue;
    const text = (evidence.get(entry.source.toLocaleLowerCase()) ?? []).join("\n");
    const lowercased = text.toLocaleLowerCase();
    const canonicalUses = occurrences(lowercased, canonicalKey);
    // A canonical the translation never once used is a registry artefact, not the truth:
    // Westinghouse came back as "Вестнигауз" and would have overwritten every "Вестингауз".
    if (!canonicalUses) continue;
    const words = new Set<string>();
    for (const match of text.matchAll(capitalizedTargetWord)) words.add(match[0]);
    for (const word of words) {
      if (replacements.has(word)) continue;
      const wordStem = stem(word);
      const wordKey = wordStem.toLocaleLowerCase();
      // Same stem means the same rendering in another case — nothing to correct.
      if (wordKey === canonicalKey) continue;
      // An ordinary word (демон), and a rendering that belongs to another entry, are both
      // out of bounds however closely they resemble this canonical form.
      if (common.has(wordKey) || canonicalStems.has(wordKey)) continue;
      // Кир/Кайр is two edits apart, so distance must reach 2; a misspelling of a name
      // keeps its initial, which is what stops that reach from catching a different name.
      if (wordKey[0] !== canonicalKey[0]) continue;
      if (Math.abs(wordStem.length - canonicalStem.length) > 1) continue;
      if (distance(wordKey, canonicalKey) > 2) continue;
      // A competing rendering of the same entity is used at a rate comparable to the
      // canonical; a different name that merely resembles it is a rounding error. Every
      // real variant in the reference run sits above 2% of the canonical's uses (Реймондо
      // is the rarest at 2.1%), and Денни — a separate character — sits at 1%.
      if (occurrences(lowercased, wordKey) * VARIANT_SHARE < canonicalUses) continue;
      const replacement = canonicalStem + word.slice(wordStem.length);
      // Gluing an ending onto a differently declined stem invents forms: Летиш + а would
      // give "Летициа". Only a form the book actually contains is a safe substitution.
      if (!attested.has(replacement)) continue;
      replacements.set(word, replacement);
    }
  }
  return {
    applied: replaceVariants(documents, replacements),
    replacements: [...replacements].map(([variant, canonical]) => ({ variant, canonical })),
  };
}

export type GlossaryAdherence = {
  source: string;
  target: string;
  blocks: number;
  blocksUsingTarget: number;
};

/**
 * How often the translation of a block that names an entity actually contains the glossary
 * rendering. The registry can be right and the run still ship both Кира and Кайра, so the
 * glossary has to be measured against the output rather than assumed to have been obeyed.
 */
export function measureGlossaryAdherence(
  documents: ConsistencyDocument[],
  glossary: GlossaryEntry[],
  nameEndings: string[] = [],
): GlossaryAdherence[] {
  const entries = glossary.filter((entry) => entry.enabled && entry.target.trim());
  const evidence = glossaryEvidence(documents, entries);
  return entries
    .map((entry) => {
      const target = entry.target.trim();
      // Match on the stem so declined renderings count as usage.
      const stem = nameStem(target, nameEndings).toLocaleLowerCase();
      const blocks = evidence.get(entry.source.toLocaleLowerCase()) ?? [];
      return {
        source: entry.source,
        target,
        blocks: blocks.length,
        blocksUsingTarget: blocks.filter((text) => text.toLocaleLowerCase().includes(stem)).length,
      };
    })
    .filter((entry) => entry.blocks > 0)
    .sort(
      (left, right) =>
        left.blocksUsingTarget / left.blocks - right.blocksUsingTarget / right.blocks,
    );
}

/** An entry the models ignored in more than half of the blocks that name it. */
export function glossaryAdherenceWarnings(adherence: GlossaryAdherence[]) {
  return adherence.filter(
    (entry) => entry.blocks >= 3 && entry.blocksUsingTarget * 2 < entry.blocks,
  );
}

/**
 * Every book-wide correction, in the order they have to run: typography, then the model's
 * decisions, then the deterministic fallback for whatever it could not decide, then the
 * navigation authority. Mutates `documents`. The pipeline and the replay tool share this so
 * that replaying a job exercises the pass the pipeline actually runs.
 */
export async function runConsistencyPass(options: {
  documents: ConsistencyDocument[];
  /** Navigation role per document id; the NCX is the authority for TOC labels. */
  navigation: Map<string, "ncx" | "nav" | null>;
  glossary: unknown[];
  sourceLanguage: ProviderLanguage;
  targetLanguage: ProviderLanguage;
  mechanics: "russian" | undefined;
  nameEndings: string[] | undefined;
  provider: LanguageModelProvider;
  profile: ProviderProfile;
  root: string;
  useExternal: boolean;
  signal?: AbortSignal;
  /** Failures from earlier in the run, so one report carries all of them. */
  errors?: string[];
}) {
  const { documents } = options;
  const glossary = options.glossary.filter(isGlossaryEntry);
  const errors = [...(options.errors ?? [])];
  const mechanicalApplied =
    options.mechanics === "russian" ? normalizeRussianConsistencyMechanics(documents) : 0;
  const resolverReport = buildConsistencyReport(documents, glossary);
  let resolution: ConsistencyResolution = {
    decisions: [],
    chunks: 0,
    resolvedChunks: 0,
    failedChunks: [],
  };
  let applied = 0;
  if (options.useExternal && resolverReport.entityEvidence.length) {
    try {
      resolution = await resolveConsistencyConflicts(
        options.provider,
        options.profile,
        options.sourceLanguage,
        options.targetLanguage,
        resolverReport,
        options.root,
        options.signal,
      );
      applied = applyConsistencyDecisions(documents, resolution.decisions, options.nameEndings);
    } catch (error) {
      errors.push(
        `Consistency resolver unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    for (const failure of resolution.failedChunks)
      errors.push(`Consistency chunk ${failure.chunk} failed: ${failure.error}`);
  }
  const glossaryAlignment = alignGlossaryVariants(documents, glossary, options.nameEndings);
  const navigationLabels = alignNavigationLabels(documents, options.navigation);
  const adherence = measureGlossaryAdherence(documents, glossary, options.nameEndings);
  const ignoredGlossaryEntries = glossaryAdherenceWarnings(adherence);
  const report = buildConsistencyReport(documents, glossary);
  return {
    ...report,
    decisions: resolution.decisions,
    chunks: resolution.chunks,
    resolvedChunks: resolution.resolvedChunks,
    failedChunks: resolution.failedChunks,
    applied,
    mechanicalApplied,
    glossaryAlignment,
    glossaryAdherence: adherence,
    ignoredGlossaryEntries,
    navigationLabels,
    errors,
  };
}

export function applyConsistencyDecisions(
  documents: ConsistencyDocument[],
  decisions: z.infer<typeof resolutionSchema>["decisions"],
  nameEndings: string[] = [],
) {
  const canonicals = new Set(decisions.map((decision) => decision.canonical));
  // Whole-word, not substring: "Ky" occurs inside every "Kyra", which made each of the
  // protagonist's blocks read as evidence for her nickname.
  const mentions = decisions.map((decision) => ({
    key: decision.source.toLocaleLowerCase(),
    pattern: new RegExp(boundedPattern(decision.source), "iu"),
  }));
  const alignedTargets = new Map<string, string[]>();
  for (const document of documents) {
    const edited = new Map(document.editedSegments.map((segment) => [segment.id, segment.text]));
    for (const sourceSegment of document.sourceSegments) {
      const text = sourceSegment.text.replace(/\s+/gu, " ");
      for (const { key, pattern } of mentions) {
        if (!pattern.test(text)) continue;
        const values = alignedTargets.get(key) ?? [];
        const target = edited.get(sourceSegment.id);
        if (target) values.push(target);
        alignedTargets.set(key, values);
      }
    }
  }
  const replacements = new Map<string, string>();
  for (const decision of decisions) {
    const evidence = alignedTargets.get(decision.source.toLocaleLowerCase()) ?? [];
    for (const variant of decision.variants) {
      // A rendering another decision settled on is that entity's answer, not this one's
      // mistake. The resolver offered Кира — its own canonical for Kyra — as a variant to
      // replace with Кай, the canonical for the nickname Ky.
      if (canonicals.has(variant)) continue;
      if (
        isSafeVariant(variant, decision.canonical, nameEndings) &&
        evidence.some((text) => text.includes(variant)) &&
        !replacements.has(variant)
      ) {
        replacements.set(variant, decision.canonical);
      }
    }
  }
  // The resolver only ever names nominatives, so Кайра → Кира left Кайры and Кайре behind.
  // An accepted decision authorises its own stem substitution: unlike the glossary fallback
  // this is not a guess, so it needs no similarity threshold — only an exact stem match,
  // which is what keeps Кирилл and Кирове out of it.
  if (nameEndings.length) {
    const observed = new Set<string>();
    for (const document of documents)
      for (const segment of document.editedSegments)
        for (const match of segment.text.matchAll(capitalizedTargetWord)) observed.add(match[0]);
    for (const [variant, canonical] of [...replacements]) {
      if (words(variant).length > 1 || words(canonical).length > 1) continue;
      const variantStem = nameStem(variant, nameEndings);
      const canonicalStem = nameStem(canonical, nameEndings);
      if (variantStem === variant || variantStem === canonicalStem) continue;
      for (const word of observed) {
        if (replacements.has(word) || canonicals.has(word)) continue;
        if (nameStem(word, nameEndings) !== variantStem) continue;
        replacements.set(word, canonicalStem + word.slice(variantStem.length));
      }
    }
  }
  return replaceVariants(documents, replacements);
}
