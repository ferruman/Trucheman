/**
 * Everything the pipeline knows about a target language, in one place. Prompt rules,
 * declension endings, and typography normalization used to be three unrelated `=== "ru"`
 * checks in three files, so adding a language silently enabled some of them and not
 * others. Supporting a language now means adding one entry here.
 */
export type TargetLanguageProfile = {
  /** Appended to the system prompt as target-language rules. */
  promptRules?: string;
  /** Structured style hints sent next to the segments in the prompt input. */
  promptStyle?: Record<string, string>;
  /**
   * Singular case endings, longest first, for names. Their presence is what lets the
   * deterministic consistency fallback carry a substitution to declined forms. Plural
   * genitive endings are deliberately absent: with "-ов", Кира → Кайра breaks Киров.
   */
  nameEndings?: string[];
  /** Typography normalization to run over the edited text, if any exists. */
  mechanics?: "russian";
};

const TARGET_LANGUAGES: Record<string, TargetLanguageProfile> = {
  ru: {
    promptRules: `Russian rules:
- Use ё consistently where standard spelling requires it.
- Use «ёлочки» with nested „лапки“.
- Transliterate personal and ship names unless an established canonical form or explicit glossary entry requires otherwise.
- Never mix translation and transliteration strategies for the same entity.
- Render English street names consistently as a transliterated name plus -стрит (for example, Thomas Street → Томас-стрит) unless an established canonical form requires otherwise.
- Punctuate dialogue by one Russian convention and never mix them: a paragraph-opening dash (— Реплика, — сказал он.) or «ёлочки» (Он сказал: «Реплика».). Never wrap a «…» quotation in dashes on both sides.
- A colon introduces speech only when the attribution comes first. When the attribution follows, close the quotation and use a comma and a dash: «Реплика», — сказал он.
- Give each speaker's turn its own paragraph, and close every quotation you open, including after an ellipsis: «Ворон…».`,
    promptStyle: {
      yo: "Use ё consistently where standard Russian spelling requires it.",
      quotes: "Use «ёлочки» and nested „лапки“ consistently.",
    },
    nameEndings: ["ою", "ею", "ой", "ей", "ом", "ем", "ём", "а", "я", "е", "и", "ы", "у", "ю"],
    mechanics: "russian",
  },
};

export function baseLanguageTag(tag: string): string {
  return tag.toLocaleLowerCase().split("-")[0];
}

export function targetLanguageProfile(tag: string | undefined): TargetLanguageProfile {
  return (tag && TARGET_LANGUAGES[baseLanguageTag(tag)]) || {};
}
