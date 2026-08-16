import { baseLanguageTag } from "./target-language.js";

/**
 * What the models have to be told about the language a book is written in, as opposed to the
 * one it is being written into. Nothing here fires for the languages the pipeline already
 * translated, so no existing checkpoint changes: `checkpointKey` hashes `sourceLanguage`
 * alongside the prompt version, and an English book's prompt comes out byte-identical.
 */
type SourceLanguageProfile = {
  /** Appended to the system prompt for any target language. */
  rules: string;
  /** Appended after those, for one target language in particular. */
  byTarget?: Record<string, string>;
};

const SOURCE_LANGUAGES: Record<string, SourceLanguageProfile> = {
  ja: {
    rules: `Japanese source rules:
- Personal names are written family name first. Keep the source order; do not rearrange them into given-name-first order.
- An entity's reading, where the glossary gives one, is the book's own furigana. Transliterate from that reading, never from a guess at how the characters are read.
- Honorifics (さん, さま, くん, ちゃん, 先生, 氏) and in-book titles are a register marker, not part of the name. Pick one policy for the whole book and never mix it: either carry the honorific over consistently or drop it consistently and carry the register in the wording around it.
- First-person pronouns (私, わたくし, 僕, 俺, わし) mark age, class and formality that the target language has no pronoun for. Carry that register in diction and syntax; do not invent a pronoun to carry it.
- Japanese leaves subjects unstated where the target language requires one. Supply the subject the context establishes; do not leave a subjectless fragment and do not invent a new actor.
- Sentence-final particles (ね, よ, な, ぞ, わ) colour a line rather than add to it. Render the colouring, never as a separate word.
- Repeated 「」 speech is dialogue: punctuate it by the target language's own convention for dialogue, not by copying the brackets.`,
    byTarget: {
      ru: `Japanese-to-Russian transliteration:
- Use the Polivanov system, which is the established convention for Russian. Never transliterate through an English (Hepburn) spelling: し is си not ши, じ is дзи not джи, ち is ти, つ is цу, しゃ is ся, じゃ is дзя, ちゃ is тя.
- Long vowels lose their length: とうきょう is Токио, こうたろう is Котаро.
- を as a particle is not part of a name; ん before a labial stays н.
- Established Russian forms win over the system where one exists (Токио, Киото, Иокогама, Хиросима).`,
    },
  },
};

export function sourceLanguageRules(sourceTag: string | undefined, targetTag?: string): string {
  const profile = sourceTag && SOURCE_LANGUAGES[baseLanguageTag(sourceTag)];
  if (!profile) return "";
  const forTarget = targetTag && profile.byTarget?.[baseLanguageTag(targetTag)];
  return [profile.rules, forTarget].filter(Boolean).join("\n\n");
}
