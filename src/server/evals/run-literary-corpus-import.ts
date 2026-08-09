import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { importLiteraryCorpusFromJob } from "./literary-corpus-import.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentsFor(name: string) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );
}

function integerArgument(name: string) {
  const value = argument(name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

const jobValues = argumentsFor("--job");
if (!jobValues.length) throw new Error("Provide one or more --job directories");
const jobRoots = jobValues.map((value) => resolve(value));
const limit = integerArgument("--limit") ?? 100;
const outputPath = resolve(
  argument("--output") ??
    `eval-results/literary-editor/imports/${jobRoots.length === 1 ? basename(jobRoots[0]) : "multi-job"}-${Date.now()}.json`,
);
const seed = argument("--seed") ?? "literary-import";
const corpora = await Promise.all(
  jobRoots.map((root, index) =>
    importLiteraryCorpusFromJob(root, {
      limit,
      minChars: integerArgument("--min-chars"),
      maxChars: integerArgument("--max-chars"),
      seed: `${seed}:${index}`,
      genre: argument("--genre"),
    }),
  ),
);
const uniqueCorpora = corpora.filter(
  (corpus, index) =>
    corpus.cases.length > 0 &&
    corpora.findIndex((candidate) => candidate.cases[0]?.bookId === corpus.cases[0]?.bookId) ===
      index,
);
const cases: (typeof corpora)[number]["cases"] = [];
const seenOriginals = new Set<string>();
for (let index = 0; cases.length < limit; index++) {
  let added = false;
  for (const corpus of uniqueCorpora) {
    const item = corpus.cases[index];
    const key = item?.original.replace(/\s+/gu, " ").toLocaleLowerCase();
    if (item && key && !seenOriginals.has(key)) {
      cases.push(item);
      seenOriginals.add(key);
      added = true;
      if (cases.length === limit) break;
    }
  }
  if (!added) break;
}
const corpus = {
  version: 1,
  description: `Unreviewed fixed-draft sample imported from ${uniqueCorpora.length} unique book(s). Add regression rules only after human review.`,
  cases,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`);
process.stdout.write(`Imported ${corpus.cases.length} fixed drafts: ${outputPath}\n`);
