import { japaneseLanguage } from "./ja.js";
import { japaneseToRussian } from "./pairs/ja-ru.js";
import { russianLanguage } from "./ru.js";
import type {
  LanguageModule,
  LanguagePairModule,
  SourceLanguageCapabilities,
  TargetLanguageCapabilities,
} from "./types.js";

const LANGUAGES = new Map<string, LanguageModule>(
  [japaneseLanguage, russianLanguage].map((language) => [language.tag, language]),
);

const PAIRS = new Map<string, LanguagePairModule>([
  [`${japaneseToRussian.source}:${japaneseToRussian.target}`, japaneseToRussian],
]);

export function baseLanguageTag(tag: string): string {
  return tag.toLocaleLowerCase().split("-")[0];
}

export function languageModule(tag: string | undefined): LanguageModule | undefined {
  return tag ? LANGUAGES.get(baseLanguageTag(tag)) : undefined;
}

export function targetLanguageCapabilities(tag: string | undefined): TargetLanguageCapabilities {
  return languageModule(tag)?.target ?? {};
}

export function sourceLanguageCapabilities(tag: string | undefined): SourceLanguageCapabilities {
  return languageModule(tag)?.source ?? {};
}

export function sourceLanguageRules(sourceTag: string | undefined, targetTag?: string): string {
  const source = sourceLanguageCapabilities(sourceTag).promptRules;
  const pair =
    sourceTag && targetTag
      ? PAIRS.get(`${baseLanguageTag(sourceTag)}:${baseLanguageTag(targetTag)}`)?.promptRules
      : undefined;
  return [source, pair].filter(Boolean).join("\n\n");
}

export type {
  LanguageModule,
  LanguagePairModule,
  SourceLanguageCapabilities,
  TargetLanguageCapabilities,
} from "./types.js";
