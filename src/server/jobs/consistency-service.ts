import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { TextSegment } from "../epub/text-segments.js";
import type {
  LanguageModelProvider,
  ProviderLanguage,
  ProviderProfile,
  ProviderSegment,
} from "../providers/provider.js";

const CONSISTENCY_VERSION = 1;

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
const wordPattern = /[\p{L}\p{M}]*[её][\p{L}\p{M}]*/giu;
const sourceStopWords = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "when",
  "where",
  "while",
  "then",
  "there",
  "but",
  "and",
  "after",
  "before",
  "however",
  "although",
  "with",
  "without",
  "from",
  "into",
  "upon",
  "chapter",
  "part",
  "project",
  "gutenberg",
  "professor",
  "doctor",
  "mister",
  "missus",
]);

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

export function extractRepeatedSourceEntities(documents: ConsistencyDocument[]): EntityEvidence[] {
  const found = new Map<
    string,
    {
      source: string;
      occurrences: number;
      nonInitialOccurrences: number;
      contexts: Array<{ source: string; target?: string }>;
    }
  >();
  for (const document of documents) {
    const edited = new Map(document.editedSegments.map((segment) => [segment.id, segment.text]));
    for (const segment of document.sourceSegments) {
      for (const match of segment.text.matchAll(sourceNamePattern)) {
        const source = match[0].replace(/[.-]+$/u, "").trim();
        const key = source.toLocaleLowerCase();
        if (sourceStopWords.has(key)) continue;
        const entry = found.get(key) ?? {
          source,
          occurrences: 0,
          nonInitialOccurrences: 0,
          contexts: [],
        };
        entry.occurrences++;
        const preceding = segment.text.slice(0, match.index).trimEnd().at(-1);
        if (preceding && !/[.!?]/u.test(preceding)) entry.nonInitialOccurrences++;
        if (entry.contexts.length < 8) {
          entry.contexts.push({ source: clipped(segment.text), target: edited.get(segment.id) });
        }
        found.set(key, entry);
      }
    }
  }
  return [...found.values()]
    .filter((entry) => entry.occurrences >= 2 && entry.nonInitialOccurrences > 0)
    .map(({ nonInitialOccurrences: _nonInitialOccurrences, ...entry }) => entry)
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences || left.source.localeCompare(right.source),
    )
    .slice(0, 250);
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
  const entityEvidence = extractRepeatedSourceEntities(documents).map((entity) => ({
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
  return { version: 1, entityEvidence, documents: documentReports, warningCount };
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

export async function resolveConsistencyConflicts(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  report: ReturnType<typeof buildConsistencyReport>,
  root: string,
  signal?: AbortSignal,
) {
  const payload = { task: "resolve_conflicts", report };
  const key = stableHash({
    version: CONSISTENCY_VERSION,
    payload,
    model: profile.model,
    targetLanguage,
  });
  const path = `${root}/consistency-resolution.json`;
  const cached = await readCache(path, key, resolutionSchema);
  const value =
    cached ??
    resolutionSchema.parse(
      await completeJsonTask(
        provider,
        profile,
        sourceLanguage,
        targetLanguage,
        "consistency-resolution",
        payload,
        signal,
      ),
    );
  if (!cached) await writeCache(path, key, value);
  return value.decisions;
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        if (!sourceSegment.text.toLocaleLowerCase().includes(decision.source.toLocaleLowerCase())) {
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
