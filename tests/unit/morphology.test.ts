import { describe, expect, it } from "vitest";
import {
  agreementFindings,
  findAgreementErrors,
  loadMorphology,
} from "../../src/server/epub/morphology.js";

/** A hand-built lexicon: the rules are what is under test, not the dictionary. */
const LEXICON: Record<string, string[][]> = {
  резкий: [
    ["ADJF", "masc", "sing", "nomn"],
    ["ADJF", "masc", "sing", "accs"],
  ],
  резкая: [["ADJF", "femn", "sing", "nomn"]],
  встряска: [["NOUN", "femn", "sing", "nomn"]],
  полным: [["ADJF", "masc", "sing", "ablt"]],
  крови: [["NOUN", "femn", "sing", "gent"]],
  два: [["NUMR", "masc", "sing", "nomn"]],
  две: [["NUMR", "femn", "sing", "nomn"]],
  отвратительных: [
    ["ADJF", "plur", "gent"],
    ["ADJF", "plur", "accs"],
  ],
  горгульи: [
    ["NOUN", "femn", "sing", "gent"],
    ["NOUN", "femn", "plur", "nomn"],
  ],
  свободных: [["ADJF", "plur", "gent"]],
  стула: [["NOUN", "masc", "sing", "gent"]],
  бледная: [["ADJF", "femn", "sing", "nomn"]],
  луна: [["NOUN", "femn", "sing", "nomn"]],
  это: [["ADJF", "Apro", "neut", "sing", "nomn"]],
  ночь: [["NOUN", "femn", "sing", "nomn"]],
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
    }));
  },
  { init: (_path: string, done: (error?: Error) => void) => done() },
);

const phrases = (text: string) => findAgreementErrors(text, morph).map((finding) => finding.phrase);

describe("findAgreementErrors", () => {
  it("reports an adjective that does not agree with its noun", () => {
    // The defect a reader found in job 02279a8b and neither the critic nor the scan saw.
    expect(phrases("Резкий встряска подчеркнула его слова.")).toEqual(["Резкий встряска"]);
    expect(phrases("Резкая встряска подчеркнула его слова.")).toEqual([]);
    expect(phrases("Бледная луна светила всю ночь.")).toEqual([]);
  });

  it("reports a numeral whose gender its noun contradicts, across the adjectives between", () => {
    expect(findAgreementErrors("Два отвратительных горгульи охраняли дверь.", morph)).toEqual([
      { phrase: "Два отвратительных горгульи", kind: "numeral_gender" },
    ]);
    expect(phrases("Две отвратительных горгульи охраняли дверь.")).toEqual([]);
  });

  it("keeps quiet where Russian only looks like it disagrees", () => {
    // The noun is what the adjective governs, not what it describes.
    expect(phrases("Он смотрел взглядом, полным крови и злобы.")).toEqual([]);
    // After «два» a noun stands in the genitive singular by rule.
    expect(phrases("В комнате было два свободных стула.")).toEqual([]);
    // A pronominal adjective agrees by other rules entirely.
    expect(phrases("Это встряска, а не удар.")).toEqual([]);
    // Only a space joins a phrase: across punctuation these are two clauses.
    expect(phrases("Он был резкий, встряска ждала его.")).toEqual([]);
    // An unknown word is not a finding: the dictionary is from 2016 and books are not.
    expect(phrases("Резкий вздрог подчеркнул его слова.")).toEqual([]);
  });
});

describe("agreementFindings", () => {
  it("finds the same defect through the real dictionary", async () => {
    // `az` is a devDependency, so the analyzer is here when the suite runs; an install
    // without it returns [] instead, the same contract as the optional EPUBCheck gate.
    expect(await loadMorphology()).toBeDefined();
    const found = await agreementFindings(
      "Резкий встряска подчеркнула его слова. Бледная луна светила всю ночь.",
    );
    expect(found).toEqual([{ phrase: "Резкий встряска", kind: "adjective_noun" }]);
  });
});
