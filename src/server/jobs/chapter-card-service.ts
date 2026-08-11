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

/** Bump only when the sampling or the card shape changes: this re-asks the model. */
const CHAPTER_CARD_VERSION = 2;
const CHAPTER_CARD_CACHE_KEY = `chapter-cards-v${CHAPTER_CARD_VERSION}`;
/**
 * A chapter is read whole — the point of the card is the facts a single batch cannot see —
 * but a long one is clipped rather than sent entire: the card is grammatical, not a summary.
 */
const CARD_BUDGET = 24000;
/** Front matter, a title page or a nav document has no characters to track. */
const MIN_CHAPTER = 2000;

const chapterCardSchema = z
  .object({
    characters: z
      .array(
        z.object({
          name: z.string(),
          gender: z.string().optional(),
          number: z.string().optional(),
          /** A phrase from the chapter that establishes the fact; checked against the source. */
          evidence: z.string().optional(),
        }),
      )
      .max(20)
      .optional(),
    address: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          register: z.string(),
          evidence: z.string().optional(),
        }),
      )
      .max(20)
      .optional(),
    terms: z
      .array(z.object({ source: z.string(), note: z.string().optional() }))
      .max(20)
      .optional(),
  })
  .strip();

export type ChapterCard = z.infer<typeof chapterCardSchema>;

function chapterText(document: ConsistencyDocument) {
  return document.sourceSegments
    .map((segment) => segment.text.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, CARD_BUDGET);
}

/** Quotes, dashes and spacing vary between what the model returns and the source it read. */
function comparable(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/[«»""''`]/gu, '"')
    .replace(/[‑–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Drop every fact the chapter does not actually support. A card is binding for every block of
 * its chapter, so an invented character or a remembered-not-read address register is repeated
 * across the whole chapter with the authority of an established fact. The critic cannot catch
 * it either: it judges one block, and the block is consistent with the card it was given.
 *
 * The same shape as the critic's spans — a claim is kept only when its quote occurs verbatim
 * in what the model was shown.
 */
export function verifyChapterCard(card: ChapterCard, chapter: string) {
  const haystack = comparable(chapter);
  const supported = (evidence: string | undefined) =>
    Boolean(evidence?.trim()) && haystack.includes(comparable(evidence!));
  const characters = (card.characters ?? []).filter((character) => supported(character.evidence));
  const address = (card.address ?? []).filter((pair) => supported(pair.evidence));
  // A recurring term is its own evidence: it has to be in the chapter to recur in it.
  const terms = (card.terms ?? []).filter((term) => supported(term.source));
  const dropped =
    (card.characters?.length ?? 0) -
    characters.length +
    ((card.address?.length ?? 0) - address.length) +
    ((card.terms?.length ?? 0) - terms.length);
  return { card: { characters, address, terms }, dropped };
}

/**
 * The card as prompt text. Only the facts a batch cannot recover on its own: who is being
 * spoken about (Russian marks gender in the past tense), how the characters address each
 * other (ты or вы is a chapter-level decision, not a sentence-level one), and the recurring
 * plain nouns that are not entities and so never reach the glossary.
 */
export function formatChapterCard(card: ChapterCard): string {
  const lines: string[] = [];
  for (const character of card.characters ?? []) {
    // The model answers "unknown" rather than leaving the character out, and a character
    // whose gender the chapter never established is the one thing this card cannot pass on:
    // gender in the past tense is why it is asked for at all. Without it the line is noise
    // handed to every batch of the chapter under the word "binding" — which is how a card
    // reading "The Project Gutenberg eBook of The Call of Cthulhu: unknown, singular" was
    // sent with all fourteen batches of a book whose narrator is never named.
    const gender = character.gender?.trim();
    if (!character.name.trim() || !gender || gender.toLocaleLowerCase() === "unknown") continue;
    const facts = [gender, character.number?.trim()].filter(Boolean);
    lines.push(`- ${character.name.trim()}: ${facts.join(", ")}`);
  }
  for (const pair of card.address ?? []) {
    if (pair.from.trim() && pair.to.trim() && pair.register.trim())
      lines.push(`- ${pair.from.trim()} addresses ${pair.to.trim()}: ${pair.register.trim()}`);
  }
  for (const term of card.terms ?? []) {
    if (term.source.trim())
      lines.push(`- recurring term "${term.source.trim()}"${term.note ? `: ${term.note}` : ""}`);
  }
  if (!lines.length) return "";
  return [
    "This chapter's established facts. They are binding for every block of this chapter, including blocks that do not name the character themselves:",
    ...lines,
  ].join("\n");
}

/**
 * One cached call per chapter, over the chapter's source, before it is translated.
 *
 * Batches are deliberately independent, so a block in the middle of a chapter arrives at the
 * model with no idea who "they" are or whether these two characters are on ты or вы terms.
 * That is not something the critic can repair afterwards — it judges the same isolated
 * block — so the facts are established once per chapter and travel with every batch of it.
 */
export async function resolveChapterCards(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  sourceLanguage: ProviderLanguage,
  targetLanguage: ProviderLanguage,
  documents: ConsistencyDocument[],
  root: string,
  signal?: AbortSignal,
  concurrency = 1,
  /** Preflight runs for minutes with no batch to report. Say which chapter it is on. */
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<{ cards: Map<string, ChapterCard>; failed: number }> {
  const path = `${root}/chapter-cards.json`;
  const cacheSchema = z.record(z.string(), chapterCardSchema);
  const cache = (await readCache(path, CHAPTER_CARD_CACHE_KEY, cacheSchema)) ?? {};
  const chapters = documents
    .map((document) => ({ id: document.id, text: chapterText(document) }))
    .filter((chapter) => chapter.text.length >= MIN_CHAPTER)
    .map((chapter) => ({
      ...chapter,
      key: stableHash({ version: CHAPTER_CARD_VERSION, text: chapter.text, targetLanguage }),
    }));
  let failed = 0;
  // One call per chapter would otherwise be a serial wait in front of the whole book, on a
  // novel long enough to have cards worth asking for. Same pool as the translation run.
  const pending = chapters.filter((chapter) => !cache[chapter.key]);
  const queue = pending.values();
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.trunc(concurrency)) }, async () => {
      for (const chapter of queue) {
        if (signal?.aborted)
          throw signal.reason instanceof Error ? signal.reason : new Error("Job paused");
        try {
          const verified = verifyChapterCard(
            chapterCardSchema.parse(
              await completeJsonTask(
                provider,
                profile,
                sourceLanguage,
                targetLanguage,
                `chapter-card-${chapter.id}`,
                { task: "chapter_card", chapter: chapter.text },
                signal,
              ),
            ),
            chapter.text,
          );
          if (verified.dropped)
            console.error(
              `Chapter card for ${chapter.id}: dropped ${verified.dropped} fact(s) the chapter does not support`,
            );
          cache[chapter.key] = verified.card;
          // Written per chapter: a run interrupted halfway keeps the chapters it paid for.
          await writeCache(path, CHAPTER_CARD_CACHE_KEY, cache);
        } catch (error) {
          if (signal?.aborted) throw error;
          // One unusable chapter is one chapter without context, not a book without cards.
          // The reason has to be said out loud: counted-and-discarded is how a chapter card
          // pass that produced nothing for a whole book still looked like one warning.
          console.error(
            `Chapter card for ${chapter.id} failed:`,
            error instanceof Error ? error.message : "unknown error",
          );
          failed++;
        }
        await onProgress?.(++done, pending.length);
      }
    }),
  );
  const cards = new Map<string, ChapterCard>();
  for (const chapter of chapters) {
    const card = cache[chapter.key];
    if (card) cards.set(chapter.id, card);
  }
  return { cards, failed };
}
