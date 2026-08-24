import { describe, expect, it } from "vitest";
import { baseLanguageTag, targetLanguageProfile } from "../../src/server/config/target-language.js";
import { buildPrompt, buildPromptInput } from "../../src/server/providers/prompts.js";
import { LANGUAGES } from "../../src/shared/languages.js";

describe("target language registry", () => {
  it("resolves regional tags to their base language", () => {
    expect(baseLanguageTag("ru-RU")).toBe("ru");
    expect(targetLanguageProfile("ru-RU")).toEqual(targetLanguageProfile("ru"));
  });

  it("returns an empty profile for a language with no rules yet", () => {
    expect(targetLanguageProfile("de")).toEqual({});
    expect(targetLanguageProfile(undefined)).toEqual({});
  });

  it("drives prompt rules, prompt style, endings, and mechanics from one entry", () => {
    const russian = targetLanguageProfile("ru");

    expect(russian.promptRules).toContain("«ёлочки»");
    expect(russian.promptStyle?.yo).toContain("ё");
    expect(russian.nameEndings).toContain("ой");
    expect(russian.mechanics).toBe("russian");
    // The plural genitive must stay out because short endings make unrelated stems collide.
    expect(russian.nameEndings).not.toContain("ов");
    expect(russian.nameEndings?.every((ending) => ending.length > 0)).toBe(true);
  });

  it("is the only thing that decides what a prompt says about a target language", () => {
    for (const language of LANGUAGES) {
      const profile = targetLanguageProfile(language.tag);
      const prompt = buildPrompt({ mode: "translation", targetLanguage: language });
      const input = JSON.parse(
        buildPromptInput({
          mode: "translation",
          sourceLanguage: { tag: "en", name: "English" },
          targetLanguage: language,
          segments: [{ id: "s1", text: "Hi" }],
        }),
      );

      expect(prompt.includes(`Target-language rules for ${language.name}`)).toBe(
        Boolean(profile.promptRules),
      );
      expect(input.targetStyle).toEqual(profile.promptStyle);
    }
  });
});
