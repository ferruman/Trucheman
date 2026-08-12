import { z } from "zod";
import type {
  LanguageModelProvider,
  ProviderLanguage,
  ProviderProfile,
} from "../providers/provider.js";
import {
  completeJsonTask,
  readCache,
  stableHash,
  writeCache,
  type ConsistencyDocument,
} from "./consistency-service.js";

/** Bump only when the sampling or the profile shape changes: this re-asks the model. */
const STYLE_PROFILE_VERSION = 2;
/**
 * A budget, not a contract — the same trap the chapter card fell into. Rejecting the profile
 * for a ninth note loses the genre, the voice and the register with it, and the book is then
 * translated with no style block at all.
 */
const MAX_NOTES = 12;
/** Enough source to hear the voice, small enough to stay one cheap preflight call. */
const SAMPLE_BUDGET = 6000;
const MIN_PASSAGE = 200;
const MAX_PASSAGE = 1200;
const SAMPLE_COUNT = 12;

export const styleProfileSchema = z
  .object({
    genre: z.string().optional(),
    narrativeVoice: z.string().optional(),
    tone: z.string().optional(),
    register: z.string().optional(),
    notes: z
      .array(z.string())
      .transform((notes) => notes.slice(0, MAX_NOTES))
      .optional(),
  })
  .strip();

export type StyleProfile = z.infer<typeof styleProfileSchema>;

/**
 * Representative prose from across the whole book. Front matter alone describes a title
 * page, not a voice, so passages are taken at an even stride through the reading order.
 */
export function sampleBookPassages(documents: ConsistencyDocument[], budget = SAMPLE_BUDGET) {
  const passages = documents
    .flatMap((document) => document.sourceSegments)
    .map((segment) => segment.text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= MIN_PASSAGE);
  const stride = Math.max(1, Math.floor(passages.length / SAMPLE_COUNT));
  const picked: string[] = [];
  let used = 0;
  for (let index = 0; index < passages.length && used < budget; index += stride) {
    const text = passages[index].slice(0, MAX_PASSAGE);
    picked.push(text);
    used += text.length;
  }
  return picked;
}

export function formatStyleProfile(profile: StyleProfile): string {
  const fields = (
    [
      ["Genre", profile.genre],
      ["Narrative voice", profile.narrativeVoice],
      ["Tone", profile.tone],
      ["Register", profile.register],
    ] as const
  ).filter(([, value]) => value?.trim());
  const notes = (profile.notes ?? []).filter((note) => note.trim());
  if (!fields.length && !notes.length) return "";
  return [
    "Book style profile, derived from the source and binding for the whole book:",
    ...fields.map(([label, value]) => `- ${label}: ${value!.trim()}`),
    ...notes.map((note) => `- ${note.trim()}`),
  ].join("\n");
}

/**
 * One cached preflight call per book: genre, voice, tone and register, fed to every later
 * stage so the whole translation sounds like one translator. Cached by the sampled text, so
 * a resumed run reuses it and the stages keep their checkpoints.
 */
export async function resolveStyleProfile(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  documents: ConsistencyDocument[],
  root: string,
  signal?: AbortSignal,
): Promise<StyleProfile | undefined> {
  const passages = sampleBookPassages(documents);
  if (!passages.length) return undefined;
  const path = `${root}/style-profile.json`;
  const key = stableHash({ version: STYLE_PROFILE_VERSION, passages, targetLanguage });
  const cached = await readCache(path, key, styleProfileSchema);
  if (cached) return cached;
  const resolved = styleProfileSchema.parse(
    await completeJsonTask(
      provider,
      profile,
      sourceLanguage,
      targetLanguage,
      "book-style",
      { task: "book_style", passages },
      signal,
      // One indivisible question with no recovery of its own, like a chapter card — and this
      // one feeds every batch of the book.
      1,
    ),
  );
  await writeCache(path, key, resolved);
  return resolved;
}
