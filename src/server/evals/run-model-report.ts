import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the finished books actually cost and how they actually scored, per model and per stage.
 *
 * Every run already writes `usage-report.json` and `quality-report.json`; nothing read them
 * across jobs, so the choice of model per stage rested on the eval corpus and on impressions.
 * Fifteen hand-written cases are not a book: this reads the books.
 */

type Usage = {
  totals: { totalTokens: number };
  breakdown: Array<{
    stage: string;
    model: string;
    requests: number;
    retriedOperations?: number;
    failedRequests?: number;
    invalidResponses?: number;
    timeouts?: number;
    promptTokens: number;
    cachedPromptTokens: number;
    completionTokens: number;
  }>;
};
type Quality = {
  auditedSegments?: number;
  flaggedSegments?: number;
  auditErrorSegments?: number;
  rejectedRepairs?: unknown[];
  scan?: { defectSegments?: number };
};
type Run = {
  id: string;
  title: string;
  book: string;
  /** Runs from different days ran different code: the comparison is only as clean as this. */
  date: string;
  qualityMode: string;
  warnings: number;
  usage: Usage;
  quality: Quality | null;
};

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Titles are typed by hand; the source archive hash is the stable book identity. */
async function bookIdentity(root: string, fallback: string) {
  try {
    return createHash("sha256")
      .update(await readFile(join(root, "source.epub")))
      .digest("hex")
      .slice(0, 8);
  } catch {
    return fallback;
  }
}

function thousands(value: number) {
  return value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : `${Math.round(value / 1000)}k`;
}

function percent(part: number, whole: number) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

function table(header: string[], rows: string[][]) {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => (cell ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

async function loadRuns(dataDir: string): Promise<Run[]> {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const runs: Run[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(dataDir, entry.name);
    const [job, usage, quality] = await Promise.all([
      readJson<{ title?: string; qualityMode?: string; warnings?: number; updatedAt?: string }>(
        join(root, "job.json"),
      ),
      readJson<Usage>(join(root, "usage-report.json")),
      readJson<Quality>(join(root, "quality-report.json")),
    ]);
    // A run with no usage report never reached a paid provider: a fixture, or a deterministic
    // e2e job. It has nothing to say about a model.
    if (!job || !usage?.breakdown?.length) continue;
    runs.push({
      id: entry.name.slice(0, 8),
      title: job.title ?? entry.name,
      book: await bookIdentity(root, entry.name.slice(0, 8)),
      date: (job.updatedAt ?? "").slice(0, 10),
      qualityMode: job.qualityMode ?? "standard",
      warnings: job.warnings ?? 0,
      usage,
      quality,
    });
  }
  return runs;
}

function modelStageTable(runs: Run[]) {
  type Group = {
    runs: Set<string>;
    requests: number;
    prompt: number;
    cached: number;
    output: number;
    retried: number;
    failed: number;
    invalid: number;
  };
  const groups = new Map<string, Group>();
  for (const run of runs)
    for (const entry of run.usage.breakdown) {
      const key = `${entry.model}\u0000${entry.stage}`;
      const group: Group = groups.get(key) ?? {
        runs: new Set<string>(),
        requests: 0,
        prompt: 0,
        cached: 0,
        output: 0,
        retried: 0,
        failed: 0,
        invalid: 0,
      };
      group.runs.add(run.id);
      group.requests += entry.requests;
      group.prompt += entry.promptTokens;
      group.cached += entry.cachedPromptTokens;
      group.output += entry.completionTokens;
      group.retried += entry.retriedOperations ?? 0;
      group.failed += entry.failedRequests ?? 0;
      group.invalid += entry.invalidResponses ?? 0;
      groups.set(key, group);
    }
  const rows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const [model, stage] = key.split("\u0000");
      return [
        model,
        stage,
        String(group.runs.size),
        String(group.requests),
        thousands(group.prompt),
        percent(group.cached, group.prompt),
        thousands(group.output),
        // The number that decides the bill: output tokens are the expensive half, and a model
        // that writes twice as much per request costs twice as much to edit a book with.
        group.requests ? String(Math.round(group.output / group.requests)) : "—",
        String(group.retried),
        String(group.failed + group.invalid),
      ];
    });
  return table(
    ["model", "stage", "runs", "req", "prompt", "cached", "output", "out/req", "retried", "bad"],
    rows,
  );
}

function qualityTable(runs: Run[]) {
  const editingModel = (run: Run) =>
    run.usage.breakdown.find((entry) => entry.stage === "editing")?.model ?? "—";
  const rows = runs
    .filter((run) => run.quality?.auditedSegments)
    .sort((a, b) => a.book.localeCompare(b.book) || a.date.localeCompare(b.date))
    .map((run) => {
      const quality = run.quality!;
      const audited = quality.auditedSegments ?? 0;
      return [
        run.book,
        run.id,
        run.date,
        editingModel(run),
        run.qualityMode,
        String(audited),
        percent(quality.flaggedSegments ?? 0, audited),
        // A critic that cannot return valid JSON reviewed nothing, however good the editor is.
        percent(quality.auditErrorSegments ?? 0, audited),
        String(quality.scan?.defectSegments ?? "—"),
        String(quality.rejectedRepairs?.length ?? 0),
        String(run.warnings),
        thousands(run.usage.totals.totalTokens),
      ];
    });
  return table(
    [
      "book",
      "run",
      "date",
      "editing model",
      "mode",
      "audited",
      "flagged",
      "auditErr",
      "scanDef",
      "rejRep",
      "warn",
      "tokens",
    ],
    rows,
  );
}

/**
 * Every rejected call, by reason. A retry that succeeds leaves nothing behind but this record,
 * and the reason is the whole difference between "the answer was cut off" (batch budget) and
 * "the model broke the contract" (prompt).
 */
async function failureTable(dataDir: string) {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const counts = new Map<string, { count: number; sample: string }>();
  let rejected = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const journal = await readFile(join(dataDir, entry.name, "usage.ndjson"), "utf8").catch(
      () => "",
    );
    for (const line of journal.split("\n")) {
      let record: { outcome?: string; stage?: string; detail?: string };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record.outcome || record.outcome === "ok") continue;
      rejected++;
      // Ids, counts and byte sizes differ on every call; the shape of the complaint does not.
      const reason = (record.detail ?? "not recorded")
        .replace(/\d+/gu, "N")
        .replace(/document-N[:#][\w.-]+/gu, "<segment>")
        .slice(0, 80);
      const key = `${record.stage ?? "?"} ${record.outcome} ${reason}`;
      const group = counts.get(key) ?? { count: 0, sample: record.detail ?? "" };
      group.count++;
      counts.set(key, group);
    }
  }
  const rows = [...counts.entries()]
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([key, group]) => {
      const [stage, outcome, ...reason] = key.split(" ");
      return [String(group.count), stage, outcome, reason.join(" ")];
    });
  return { rejected, table: table(["calls", "stage", "outcome", "reason"], rows) };
}

const dataDir = argument("--data", "data/jobs");
const runs = await loadRuns(dataDir);
if (!runs.length) {
  console.error(`No run with a usage report under ${dataDir}`);
  process.exitCode = 2;
} else {
  const books = new Set(runs.map((run) => run.book));
  console.log(
    `${runs.length} paid run(s) over ${books.size} distinct source book(s) in ${dataDir}`,
  );
  console.log(`\nCost by model and stage\n\n${modelStageTable(runs)}`);
  console.log(`\nQuality by run, oldest first within each book\n\n${qualityTable(runs)}`);
  const failures = await failureTable(dataDir);
  if (failures.rejected)
    console.log(`\n${failures.rejected} rejected call(s), by reason\n\n${failures.table}`);
  // Runs of one book differ only in configuration, so they are the only honest comparison here.
  for (const book of books) {
    const sameBook = runs.filter((run) => run.book === book);
    if (sameBook.length > 1)
      console.log(
        `\nSame source (${book}): ${sameBook.map((run) => `${run.id} "${run.title}"`).join(", ")}`,
      );
  }
}
