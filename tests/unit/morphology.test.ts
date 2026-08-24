import { describe, expect, it } from "vitest";
import {
  agreementFindings,
  findAgreementErrors,
  loadMorphology,
  proposeAgreementFixes,
} from "../../src/server/epub/morphology.js";

/** A hand-built lexicon: the rules are what is under test, not the dictionary. */
const LEXICON: Record<string, string[][]> = {
  маленький: [
    ["ADJF", "masc", "sing", "nomn"],
    ["ADJF", "masc", "sing", "accs"],
  ],
  маленькая: [["ADJF", "femn", "sing", "nomn"]],
  дверь: [["NOUN", "femn", "sing", "nomn"]],
  полным: [["ADJF", "masc", "sing", "ablt"]],
  удивления: [["NOUN", "neut", "sing", "gent"]],
  два: [["NUMR", "masc", "sing", "nomn"]],
  две: [["NUMR", "femn", "sing", "nomn"]],
  белых: [
    ["ADJF", "plur", "gent"],
    ["ADJF", "plur", "accs"],
  ],
  перчатки: [
    ["NOUN", "femn", "sing", "gent"],
    ["NOUN", "femn", "plur", "nomn"],
  ],
  свободных: [["ADJF", "plur", "gent"]],
  стула: [["NOUN", "masc", "sing", "gent"]],
  бледная: [["ADJF", "femn", "sing", "nomn"]],
  луна: [["NOUN", "femn", "sing", "nomn"]],
  бледный: [["ADJF", "masc", "sing", "nomn"]],
  это: [["ADJF", "Apro", "neut", "sing", "nomn"]],
  ночь: [["NOUN", "femn", "sing", "nomn"]],
};

/** Only the forms a test needs; a missing one stands for "the paradigm has no such form". */
const FORMS: Record<string, string> = {
  "маленький:femn,sing,nomn": "маленькая",
  "полным:femn,sing,gent": "полной",
};

const morph = Object.assign(
  (word: string) => {
    const parses = LEXICON[word.toLocaleLowerCase()];
    if (!parses) return undefined;
    return parses.map((flags) => ({
      tag: Object.assign(Object.fromEntries(flags.map((flag) => [flag, true])), {
        toString: () => flags.join(","),
      }),
      score: 1 / parses.length,
      inflect: (grammemes: string[]) => {
        const form = FORMS[`${word.toLocaleLowerCase()}:${grammemes.join(",")}`];
        return form ? { toString: () => form } : undefined;
      },
    }));
  },
  { init: (_path: string, done: (error?: Error) => void) => done() },
);

const phrases = (text: string) => findAgreementErrors(text, morph).map((finding) => finding.phrase);

describe("findAgreementErrors", () => {
  it("reports an adjective that does not agree with its noun", () => {
    expect(phrases("Маленький дверь вела в сад.")).toEqual(["Маленький дверь"]);
    expect(phrases("Маленькая дверь вела в сад.")).toEqual([]);
    expect(phrases("Бледная луна светила всю ночь.")).toEqual([]);
  });

  it("reports a numeral whose gender its noun contradicts, across the adjectives between", () => {
    expect(findAgreementErrors("Два белых перчатки лежали у Кролика.", morph)).toEqual([
      { phrase: "Два белых перчатки", kind: "numeral_gender" },
    ]);
    expect(phrases("Две белых перчатки лежали у Кролика.")).toEqual([]);
  });

  it("keeps quiet where Russian only looks like it disagrees", () => {
    // The noun is what the adjective governs, not what it describes.
    expect(phrases("Он смотрел взглядом, полным удивления.")).toEqual([]);
    // After «два» a noun stands in the genitive singular by rule.
    expect(phrases("В комнате было два свободных стула.")).toEqual([]);
    // A pronominal adjective agrees by other rules entirely.
    expect(phrases("Это дверь, а не окно.")).toEqual([]);
    // Only a space joins a phrase: across punctuation these are two clauses.
    expect(phrases("Он был маленький, дверь ждала его.")).toEqual([]);
    // An unknown word is not a finding: the dictionary is from 2016 and books are not.
    expect(phrases("Маленький ключик лежал на столе.")).toEqual([]);
  });
});

describe("proposeAgreementFixes", () => {
  it("derives the correction and keeps the original capitalisation", () => {
    expect(proposeAgreementFixes("Маленький дверь вела в сад.", morph)).toEqual([
      { phrase: "Маленький дверь", replacement: "Маленькая дверь", kind: "adjective_noun" },
    ]);
  });

  it("corrects a numeral by swapping the only other form it has", () => {
    expect(proposeAgreementFixes("Два белых перчатки лежали у Кролика.", morph)[0]).toMatchObject({
      replacement: "Две белых перчатки",
    });
  });

  it("proposes nothing when the paradigm has no such form", () => {
    // «Маленький» inflects; a word whose form is missing is left to a human rather than guessed.
    const [finding] = findAgreementErrors("Бледный дверь ждала его.", morph);
    expect(finding?.phrase).toBe("Бледный дверь");
    expect(proposeAgreementFixes("Бледный дверь ждала его.", morph)).toEqual([]);
  });
});

describe("agreementFindings", () => {
  it("finds the same defect through the real dictionary", async () => {
    // `az` is a devDependency, so the analyzer is here when the suite runs; an install
    // without it returns [] instead, the same contract as the optional EPUBCheck gate.
    expect(await loadMorphology()).toBeDefined();
    const found = await agreementFindings(
      "Маленький дверь вела в сад. Бледная луна светила всю ночь.",
    );
    expect(found).toEqual([{ phrase: "Маленький дверь", kind: "adjective_noun" }]);
  });
});
