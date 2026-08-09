import { appendJournal, readJournal } from "../storage/ndjson-journal.js";
export type NameEntry = {
  id: string;
  source: string;
  target: string;
  category: "person" | "place" | "organization" | "other";
  enabled: boolean;
};
export async function resumeNameAnalysis(
  root: string,
  batches: string[][],
  analyze: (batch: string[]) => Promise<NameEntry[]>,
): Promise<NameEntry[]> {
  const completed = await readJournal<{ batch: number; entries: NameEntry[] }>(
      `${root}/name-analysis.ndjson`,
    ),
    done = new Set(completed.map((x) => x.batch)),
    entries = completed.flatMap((x) => x.entries);
  for (let i = 0; i < batches.length; i++) {
    if (done.has(i)) continue;
    const result = await analyze(batches[i]);
    await appendJournal(`${root}/name-analysis.ndjson`, { batch: i, entries: result });
    entries.push(...result);
  }
  const seen = new Map<string, NameEntry>();
  for (const item of entries) {
    const key = item.source.trim().toLocaleLowerCase();
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}
