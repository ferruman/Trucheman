/**
 * Replay the book-wide consistency pass over a job's existing translations.
 *
 * The pass reads `edits.ndjson`, so it can be re-run without paying for translation again —
 * roughly a seventh of a full run. Everything it writes — reports and its own model caches —
 * goes to <job>/replay/, so the run being inspected is never modified.
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveProfiles } from "../config/profiles.js";
import { targetLanguageProfile } from "../config/target-language.js";
import { mergeChunkedSegments } from "../epub/batcher.js";
import { validateJob } from "../domain/job.js";
import { providerLanguage, type PreparedBook } from "../jobs/book-pipeline.js";
import {
  mergeGlossaries,
  resolveEntityRegistry,
  runConsistencyPass,
  type ConsistencyDocument,
} from "../jobs/consistency-service.js";
import { UsageTrackingProvider } from "../jobs/usage-service.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { readJournal } from "../storage/ndjson-journal.js";
import { atomicJson } from "../storage/atomic-file.js";

const root = process.argv[2] && resolve(process.argv[2]);
if (!root) {
  console.error("Usage: npm run replay:consistency -- <path/to/data/jobs/<id>>");
  process.exit(2);
}

// The registry and resolution caches are keyed by path, and the pipeline shares them with
// the job. Give the replay its own directory so a replay can never overwrite the artefacts
// of the run it is inspecting.
const workspace = `${root}/replay`;
await mkdir(workspace, { recursive: true });

const job = validateJob(JSON.parse(await readFile(`${root}/job.json`, "utf8")));
const prepared: PreparedBook = JSON.parse(await readFile(`${root}/prepared.json`, "utf8"));
const edits = new Map(
  (
    await readJournal<{ batchId: string; segments: { id: string; text: string }[] }>(
      `${root}/edits.ndjson`,
    )
  ).map((record) => [record.batchId, record.segments]),
);

const documents: ConsistencyDocument[] = prepared.documents.map((document) => ({
  id: document.id,
  // `units` is absent in books prepared before logical blocks existed.
  sourceSegments: document.units ?? document.segments,
  editedSegments: mergeChunkedSegments(
    document.batches.flatMap((batch) => edits.get(batch.id) ?? []),
  ),
}));
const covered = documents.filter((document) => document.editedSegments.length).length;
if (!covered) {
  console.error(
    "No edited segments matched this job's batches. The journal was written by a different " +
      "preparation of the book, so there is nothing to replay.",
  );
  process.exit(1);
}

const { useExternal, consistency: profile } = resolveProfiles();
const provider = new UsageTrackingProvider(
  useExternal ? new DeepSeekProvider() : new FakeProvider(),
  workspace,
);
const sourceLanguage = providerLanguage(job.sourceLanguage);
const targetLanguage = providerLanguage(job.targetLanguage);
const rules = targetLanguageProfile(targetLanguage.tag);

const errors: string[] = [];
let generated: Awaited<ReturnType<typeof resolveEntityRegistry>>["entries"] = [];
if (useExternal) {
  try {
    const registry = await resolveEntityRegistry(
      provider,
      profile,
      sourceLanguage,
      targetLanguage,
      prepared.documents.map((document) => ({
        id: document.id,
        sourceSegments: document.units ?? document.segments,
        editedSegments: [],
      })),
      workspace,
    );
    generated = registry.entries;
    for (const failure of registry.failedChunks)
      errors.push(`Entity registry chunk ${failure.chunk} failed: ${failure.error}`);
  } catch (error) {
    errors.push(
      `Entity registry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

const report = await runConsistencyPass({
  documents,
  navigation: new Map(prepared.documents.map((d) => [d.id, d.navigation ?? null])),
  glossary: mergeGlossaries(job.glossary, generated),
  sourceLanguage,
  targetLanguage,
  normalizeConsistency: rules.normalizeConsistency,
  nameEndings: rules.nameEndings,
  provider,
  profile,
  root: workspace,
  useExternal,
});

await atomicJson(`${workspace}/consistency-report.json`, report);
await atomicJson(
  `${workspace}/edits.json`,
  documents.map((document) => ({ id: document.id, segments: document.editedSegments })),
);

const unbalanced = report.documents.filter((document) => !document.quotes.balanced).length;
console.log(
  [
    `provider           ${useExternal ? `${profile.model} @ ${profile.endpoint}` : "deterministic (no API key)"}`,
    `documents          ${covered}/${prepared.documents.length} with translations`,
    `entities           ${report.entityStats.kept} kept, ${report.entityStats.overflow} over the cap`,
    `resolver           ${report.resolvedChunks}/${report.chunks} chunks, ${report.decisions.length} decisions, ${report.applied} replacements`,
    `glossary fallback  ${report.glossaryAlignment.applied} replacements from ${report.glossaryAlignment.replacements.length} variants`,
    `typography         ${report.mechanicalApplied} fixes`,
    `navigation         ${report.navigationLabels.applied} labels aligned`,
    `glossary ignored   ${report.ignoredGlossaryEntries.length} entries used in under half their blocks`,
    `quote/ё warnings   ${report.warningCount} (${unbalanced} documents with unbalanced guillemets)`,
    `errors             ${report.errors.length ? report.errors.join("; ") : "none"}`,
    ``,
    `wrote ${workspace}/ (the job's own artefacts are untouched)`,
  ].join("\n"),
);
if (report.errors.length) process.exitCode = 1;
