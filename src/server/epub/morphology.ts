import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Russian adjective/noun agreement over the built book, checked against a morphological
 * dictionary. Nothing else in the pipeline can see it: the critic is the same model family as
 * the editor and reads «Резкий встряска» as correct, and every other check here works on
 * characters rather than grammar.
 *
 * Optional, exactly like EPUBCheck: `az` is a 12 MB package that most installs do not want, so
 * an install without it silently reports nothing rather than failing the audit. This is a
 * report — nothing is rewritten on its word — because roughly one finding in three is real,
 * far below what `job-runner` requires before it will pay a model to rewrite a block.
 */
export type AgreementFinding = {
  phrase: string;
  kind: "adjective_noun" | "numeral_gender";
};

/** One parse of one word, reduced to what agreement needs. */
type Grammemes = { gender: string; number: string; case: string };
type Parse = { tag: Record<string, boolean> & { toString(): string }; score: number };
type Morph = ((word: string) => Parse[] | undefined) & {
  init: (path: string, done: (error?: Error) => void) => void;
};

const GENDERS = ["masc", "femn", "neut"];
const NUMBERS = ["sing", "plur"];
const CASES = ["nomn", "gent", "datv", "accs", "ablt", "loct", "voct", "gen2", "acc2", "loc2"];
/** After «два/три/четыре» a Russian noun stands in the genitive singular by rule, not by error. */
const COUNTING = /^(два|две|три|четыре|оба|обе|полтора|полторы)$/iu;
const WORD = /[\p{L}\p{M}ё-]+/gu;
/** How far a numeral may stand from its noun: «два отвратительных горгульи». */
const MAX_NUMERAL_GAP = 3;

function grammemes(parse: Parse): Grammemes {
  return {
    gender: GENDERS.find((value) => parse.tag[value]) ?? "?",
    number: NUMBERS.find((value) => parse.tag[value]) ?? "?",
    case: CASES.find((value) => parse.tag[value]) ?? "?",
  };
}

/** Plural adjectives carry no gender, so only number and case can disagree there. */
function agrees(adjective: Grammemes, noun: Grammemes) {
  return (
    adjective.number === noun.number &&
    adjective.case === noun.case &&
    (adjective.number === "plur" || adjective.gender === noun.gender)
  );
}

export function findAgreementErrors(text: string, morph: Morph): AgreementFinding[] {
  const tokens = [...text.matchAll(WORD)];
  const parse = (word: string) => morph(word) ?? [];
  const findings: AgreementFinding[] = [];
  const seen = new Set<string>();
  const report = (phrase: string, kind: AgreementFinding["kind"]) => {
    const key = `${kind}:${phrase.toLocaleLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ phrase, kind });
  };
  const sentenceStart = (index: number) => {
    if (index === 0) return true;
    const previous = tokens[index - 1];
    return /[.!?—«"\n]/u.test(
      text.slice((previous.index ?? 0) + previous[0].length, tokens[index].index),
    );
  };
  for (let index = 1; index < tokens.length; index++) {
    const first = tokens[index - 1][0],
      second = tokens[index][0];
    // Only a plain space between them: anything else is a new clause, not a phrase.
    if (text.slice((tokens[index - 1].index ?? 0) + first.length, tokens[index].index) !== " ")
      continue;
    // A capital mid-sentence is a name, and a name's dictionary gender is not its bearer's.
    if (/\p{Lu}/u.test(first[0]) && !sentenceStart(index - 1)) continue;
    if (/\p{Lu}/u.test(second[0])) continue;
    if (index >= 2 && COUNTING.test(tokens[index - 2][0])) continue;
    const firstParses = parse(first),
      secondParses = parse(second);
    // Pronominal adjectives («это», «всё», «остальных») agree by other rules; a word that can
    // be another part of speech at all is ambiguous enough to leave alone.
    const adjectives = firstParses.filter(
      (item) => item.tag.ADJF && !item.tag.Apro && !item.tag.Anum,
    );
    const nouns = secondParses.filter((item) => item.tag.NOUN);
    if (!adjectives.length || !nouns.length) continue;
    if (firstParses.some((item) => !item.tag.ADJF && item.score > 0.2)) continue;
    if (secondParses.some((item) => !item.tag.NOUN && item.score > 0.2)) continue;
    const nounForms = nouns.map(grammemes),
      adjectiveForms = adjectives.map(grammemes);
    // No case in common means the noun is not what the adjective describes but what it
    // governs — «полным крови», «подобное телу», «гонимый дисциплиной» are all correct.
    const nounCases = new Set(nounForms.map((form) => form.case));
    if (!adjectiveForms.some((form) => nounCases.has(form.case))) continue;
    if (!adjectiveForms.some((adjective) => nounForms.some((noun) => agrees(adjective, noun))))
      report(`${first} ${second}`, "adjective_noun");
  }
  for (let index = 0; index < tokens.length; index++) {
    const numeral = tokens[index][0];
    if (!/^(два|две)$/iu.test(numeral)) continue;
    // «Два отвратительных горгульи»: the adjectives in between are correctly genitive, and
    // only the numeral gives the noun's gender away.
    let ahead = index + 1,
      noun: string | undefined;
    while (ahead < Math.min(index + 1 + MAX_NUMERAL_GAP, tokens.length)) {
      const parses = parse(tokens[ahead][0]);
      if (parses.some((item) => item.tag.NOUN)) {
        noun = tokens[ahead][0];
        break;
      }
      if (!parses.some((item) => item.tag.ADJF)) break;
      ahead++;
    }
    if (!noun) continue;
    const nouns = parse(noun).filter((item) => item.tag.NOUN);
    const feminine = nouns.every((item) => item.tag.femn);
    const masculine = nouns.every((item) => !item.tag.femn);
    const saidFeminine = numeral.toLocaleLowerCase() === "две";
    if ((saidFeminine && masculine) || (!saidFeminine && feminine))
      report(
        tokens
          .slice(index, ahead + 1)
          .map((token) => token[0])
          .join(" "),
        "numeral_gender",
      );
  }
  return findings;
}

let loading: Promise<Morph | undefined> | undefined;

/**
 * The analyzer and its dictionaries, or `undefined` when `az` is not installed. Loaded once:
 * the dictionaries are 11 MB, and a book is audited as one text rather than per batch.
 */
export async function loadMorphology(): Promise<Morph | undefined> {
  loading ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const dictionaries = join(dirname(require.resolve("az/package.json")), "dicts");
      const az = require("az") as { Morph: Morph };
      await new Promise<void>((resolve, reject) =>
        az.Morph.init(dictionaries, (error?: Error) => (error ? reject(error) : resolve())),
      );
      return az.Morph;
    } catch {
      return undefined;
    }
  })();
  return loading;
}

export async function agreementFindings(text: string): Promise<AgreementFinding[]> {
  const morph = await loadMorphology();
  return morph ? findAgreementErrors(text, morph) : [];
}
