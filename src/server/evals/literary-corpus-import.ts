import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { persistedJobSchema } from "../domain/job.js";
import { readJournal } from "../storage/ndjson-journal.js";
import { LANGUAGES } from "../../shared/languages.js";

const segmentSchema = z.object({ id: z.string(), text: z.string() });
const preparedSchema = z.object({
  documents: z.array(z.object({ segments: z.array(segmentSchema) })),
});
const checkpointSchema = z.object({ segments: z.array(segmentSchema) });

export type LiteraryCorpusImportOptions = {
  limit?: number;
  minChars?: number;
  maxChars?: number;
  seed?: string;
  genre?: string;
};

function language(tag: string) {
  return LANGUAGES.find((candidate) => candidate.tag === tag) ?? { tag, name: tag };
}

function rank(seed: string, id: string) {
  return createHash("sha256").update(`${seed}:${id}`).digest("hex");
}

function safeId(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function stratifiedSample<T extends { id: string; original: string }>(
  candidates: T[],
  limit: number,
  seed: string,
) {
  const buckets: T[][] = [[], [], []];
  for (const candidate of candidates) {
    const bucket = candidate.original.length < 240 ? 0 : candidate.original.length < 700 ? 1 : 2;
    buckets[bucket].push(candidate);
  }
  for (const bucket of buckets) {
    bucket.sort((left, right) => rank(seed, left.id).localeCompare(rank(seed, right.id)));
  }
  const selected: T[] = [];
  while (selected.length < limit && buckets.some((bucket) => bucket.length)) {
    for (const bucket of buckets) {
      const candidate = bucket.shift();
      if (candidate) selected.push(candidate);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

export async function importLiteraryCorpusFromJob(
  root: string,
  options: LiteraryCorpusImportOptions = {},
) {
  const job = persistedJobSchema.parse(JSON.parse(await readFile(join(root, "job.json"), "utf8")));
  const bookId = createHash("sha256")
    .update(await readFile(join(root, "source.epub")))
    .digest("hex");
  const prepared = preparedSchema.parse(
    JSON.parse(await readFile(join(root, "prepared.json"), "utf8")),
  );
  const records = (await readJournal<unknown>(join(root, "drafts.ndjson"))).flatMap((record) => {
    const parsed = checkpointSchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
  const drafts = new Map<string, string>();
  for (const record of records) {
    for (const segment of record.segments) drafts.set(segment.id, segment.text);
  }
  const minChars = options.minChars ?? 80;
  const maxChars = options.maxChars ?? 1800;
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (minChars < 1 || maxChars < minChars) throw new Error("invalid character range");

  const seen = new Set<string>();
  const candidates = prepared.documents.flatMap((document) =>
    document.segments.flatMap((segment) => {
      const original = segment.text.trim();
      const draft = drafts.get(segment.id)?.trim();
      const duplicateKey = original.replace(/\s+/gu, " ").toLocaleLowerCase();
      if (
        !draft ||
        original.length < minChars ||
        original.length > maxChars ||
        original === draft ||
        seen.has(duplicateKey)
      ) {
        return [];
      }
      seen.add(duplicateKey);
      return [{ id: segment.id, original, draft }];
    }),
  );
  const seed = options.seed ?? job.id;
  const selected = stratifiedSample(candidates, Math.min(limit, candidates.length), seed);
  const sourceLanguage = language(job.sourceLanguage);
  const targetLanguage = language(job.targetLanguage);
  const jobLabel = safeId(job.title) || job.id.slice(0, 8);
  return {
    version: 1,
    description: `Unreviewed fixed-draft sample imported from ${job.title}. Add regression rules only after human review.`,
    cases: selected.map((candidate, index) => ({
      id: `${jobLabel}-${job.id.slice(0, 8)}-${String(index + 1).padStart(3, "0")}-${safeId(candidate.id)}`,
      bookId,
      genre: options.genre ?? "unclassified",
      sourceLanguage,
      targetLanguage,
      original: candidate.original,
      draft: candidate.draft,
      forbidden: [],
      requiredAny: [],
      requireChange: false,
      reviewNotes: `Imported from job ${job.id}; source segment ${candidate.id}; unreviewed.`,
    })),
  };
}
