import type { LanguageModule } from "./types.js";
import {
  horizontalizePackage,
  latinizeStagedStylesheets,
  normalizeJapaneseContent,
} from "../epub/japanese.js";

export const japaneseLanguage: LanguageModule = {
  tag: "ja",
  source: {
    batchCharBudget: 4000,
    batchSegmentCap: 10,
    preparePackage: async (document, staging) => {
      const changed = horizontalizePackage(document);
      await latinizeStagedStylesheets(staging);
      return changed;
    },
    normalizeContent: normalizeJapaneseContent,
    promptRules: `Japanese source rules:
- Personal names are written family name first. Keep the source order; do not rearrange them into given-name-first order.
- An entity's reading, where the glossary gives one, is the book's own furigana. Transliterate from that reading, never from a guess at how the characters are read.
- Honorifics (さん, さま, くん, ちゃん, 先生, 氏) and in-book titles are a register marker, not part of the name. Pick one policy for the whole book and never mix it: either carry the honorific over consistently or drop it consistently and carry the register in the wording around it.
- First-person pronouns (私, わたくし, 僕, 俺, わし) mark age, class and formality that the target language has no pronoun for. Carry that register in diction and syntax; do not invent a pronoun to carry it.
- Japanese leaves subjects unstated where the target language requires one. Supply the subject the context establishes; do not leave a subjectless fragment and do not invent a new actor.
- Sentence-final particles (ね, よ, な, ぞ, わ) colour a line rather than add to it. Render the colouring, never as a separate word.
- Repeated 「」 speech is dialogue: punctuate it by the target language's own convention for dialogue, not by copying the brackets.`,
  },
};
