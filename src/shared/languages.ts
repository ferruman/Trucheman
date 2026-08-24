export const LANGUAGES = [
  { tag: "en", name: "English" },
  { tag: "ru", name: "Russian" },
  { tag: "de", name: "German" },
  { tag: "pl", name: "Polish" },
  { tag: "ja", name: "Japanese" },
] as const;
export type LanguageTag = (typeof LANGUAGES)[number]["tag"];
export function isLanguageTag(value: string): value is LanguageTag {
  return LANGUAGES.some((x) => x.tag === value);
}
export function assertLanguagePair(source: string, target: string): void {
  if (!isLanguageTag(source) || !isLanguageTag(target))
    throw new Error("Unsupported language pair");
  if (source === target) throw new Error("Source and target languages must differ");
}
