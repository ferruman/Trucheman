import type { LanguagePairModule } from "../types.js";

export const japaneseToRussian: LanguagePairModule = {
  source: "ja",
  target: "ru",
  promptRules: `Japanese-to-Russian transliteration:
- Use the Polivanov system, which is the established convention for Russian. Never transliterate through an English (Hepburn) spelling: し is си not ши, じ is дзи not джи, ち is ти, つ is цу, しゃ is ся, じゃ is дзя, ちゃ is тя.
- Long vowels lose their length: とうきょう is Токио, こうたろう is Котаро.
- を as a particle is not part of a name; ん before a labial stays н.
- Established Russian forms win over the system where one exists (Токио, Киото, Иокогама, Хиросима).`,
};
