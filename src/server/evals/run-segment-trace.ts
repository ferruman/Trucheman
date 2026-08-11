/**
 * Print one segment's whole life: source -> draft -> edit -> audit -> repair -> final XHTML.
 *
 * The data already exists in the journals; this only joins them by id so a single block can be
 * inspected without re-running any stage. Read-only: it writes nothing.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseXml } from "../epub/xml-dom.js";
import { extractTextSegments } from "../epub/text-segments.js";
import type { PreparedBook } from "../jobs/book-pipeline.js";
import { readJournal } from "../storage/ndjson-journal.js";

const root = process.argv[2] && resolve(process.argv[2]);
const wanted = process.argv[3];
if (!root || !wanted) {
  console.error("Usage: npm run trace:segment -- <path/to/data/jobs/<id>> <segment-id>");
  process.exit(2);
}

type JournalRecord = {
  batchId: string;
  segments: { id: string; text: string }[];
  checkpointKey?: string;
  attempts?: number;
  profile?: string;
};

const prepared: PreparedBook = JSON.parse(await readFile(`${root}/prepared.json`, "utf8"));

/** A unit larger than the batch budget travels as `<id>#1`, `<id>#2`; both belong to `id`. */
const belongs = (id: string) => id === wanted || id.startsWith(`${wanted}#`);
const textOf = (segments: { id: string; text: string }[] = []) =>
  segments
    .filter((segment) => belongs(segment.id))
    .map((segment) => segment.text)
    .join("");

const document = prepared.documents.find((candidate) =>
  (candidate.units ?? candidate.segments).some((segment) => belongs(segment.id)),
);
if (!document) {
  const absorbedInto = prepared.documents
    .flatMap((candidate) => Object.entries(candidate.absorbed ?? {}))
    .find(([absorbed]) => absorbed === wanted)?.[1];
  console.error(
    absorbedInto
      ? `${wanted} was merged into logical block ${absorbedInto}; trace that id instead.`
      : `No prepared segment matches ${wanted}.`,
  );
  process.exit(1);
}
const batch = document.batches.find((candidate) =>
  candidate.segments.some((segment) => belongs(segment.id)),
);

const stage = async (file: string) => {
  const records = await readJournal<JournalRecord>(`${root}/${file}`);
  // Last write wins: a resumed run appends a fresh record for the same batch.
  return records.filter((record) => record.batchId === batch?.id && textOf(record.segments)).at(-1);
};
const [draft, edit, audit, repair] = await Promise.all(
  ["drafts.ndjson", "edits.ndjson", "audits.ndjson", "repairs.ndjson"].map(stage),
);

/**
 * Staging holds the reinserted, consistency-corrected text — the same bytes the EPUB got.
 * Re-extracting it renumbers the ids, because merging a logical block empties the text nodes it
 * absorbed and an empty node is no longer a segment. Joining on the id therefore reads whatever
 * block happens to sit at that index now; the locator is the node's position in the tree, which
 * reinsertion does not move.
 */
const at = (locator: number[]) => locator.join(".");
const wantedLocators = new Set(
  (document.units ?? document.segments)
    .filter((segment) => belongs(segment.id))
    .map((segment) => at(segment.locator)),
);
let final: string | undefined;
try {
  const staged = extractTextSegments(parseXml(await readFile(document.path)), document.id);
  final = staged
    .filter((segment) => wantedLocators.has(at(segment.locator)))
    .map((segment) => segment.text)
    .join("");
} catch {
  final = undefined;
}

const describe = (record?: JournalRecord) =>
  record ? ` (${record.profile ?? "?"}, ${record.attempts ?? 1} attempt(s))` : "";
const show = (label: string, value: string | undefined, note = "") =>
  console.log(`\n${label}${note}\n${value?.trim() ? value : "—"}`);

console.log(
  [
    `segment   ${wanted}`,
    `document  ${document.id}  ${document.path}`,
    `batch     ${batch?.id ?? "not batched"}`,
  ].join("\n"),
);
show("SOURCE", textOf(document.units ?? document.segments));
show("DRAFT", textOf(draft?.segments), describe(draft));
show("EDIT", textOf(edit?.segments), describe(edit));
show("AUDIT", textOf(audit?.segments), describe(audit));
show("REPAIR", repair ? textOf(repair.segments) : "not flagged for repair", describe(repair));
show("FINAL (staging)", final ?? "staging has no translation for this id yet");
