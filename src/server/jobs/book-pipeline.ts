import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractEpub } from "../epub/extract.js";
import { parseContainer, parsePackage } from "../epub/package-parser.js";
import { makeBatches, mergeChunkedSegments, type Batch } from "../epub/batcher.js";
import { extractTextSegments, reinsertText, type TextSegment } from "../epub/text-segments.js";
import { parseXml, serializeXml } from "../epub/xml-dom.js";
import { buildEpub } from "../epub/build.js";
import { auditEpubArchive } from "../epub/consistency-audit.js";
import { resolveEpubPath, validateEpubArchive } from "../epub/validate.js";
import { updateContentLanguage, updatePackageLanguage } from "../epub/localization.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { resolveProfiles } from "../config/profiles.js";
import { LANGUAGES } from "../../shared/languages.js";
import { runTwoPass } from "./job-runner.js";
import type { PersistedJob } from "../domain/job.js";
import { syncParentDirectory } from "../storage/atomic-file.js";
import {
  applyConsistencyDecisions,
  buildConsistencyReport,
  isGlossaryEntry,
  mergeGlossaries,
  normalizeRussianConsistencyMechanics,
  resolveConsistencyConflicts,
  resolveEntityRegistry,
  type ConsistencyDocument,
  type GlossaryEntry,
} from "./consistency-service.js";

export type PreparedDocument = {
  id: string;
  path: string;
  title: string;
  segments: TextSegment[];
  batches: Batch[];
};
export type PreparedBook = { staging: string; packageFile: string; documents: PreparedDocument[] };

export function providerLanguage(tag: string) {
  const language = LANGUAGES.find((candidate) => candidate.tag === tag);
  if (!language) throw new Error(`Unsupported language: ${tag}`);
  return { tag: language.tag, name: language.name };
}

export async function prepareBook(root: string): Promise<PreparedBook> {
  const staging = join(root, "staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await extractEpub(join(root, "source.epub"), staging);
  const packagePath = parseContainer(
    await readFile(join(staging, "META-INF/container.xml"), "utf8"),
  );
  const packageFile = resolveEpubPath(staging, packagePath);
  const bookPackage = parsePackage(await readFile(packageFile, "utf8"), packagePath);
  const documents: PreparedDocument[] = [];
  const documentIds = [...bookPackage.spine];
  for (const [id, item] of bookPackage.manifest) {
    const isNavigationDocument =
      /x-dtbncx/i.test(item.mediaType) ||
      (/(xhtml|html)/i.test(item.mediaType) && item.properties?.split(/\s+/).includes("nav"));
    if (isNavigationDocument && !documentIds.includes(id)) documentIds.push(id);
  }
  for (const [index, id] of documentIds.entries()) {
    const item = bookPackage.manifest.get(id);
    if (!item || !/(xhtml|html|x-dtbncx)/i.test(item.mediaType)) continue;
    const path = resolveEpubPath(staging, item.href, posix.dirname(packagePath));
    const documentId = `document-${index + 1}`;
    const segments = extractTextSegments(parseXml(await readFile(path)), documentId);
    documents.push({ id: documentId, path, title: id, segments, batches: makeBatches(segments) });
  }
  if (!documents.length)
    throw new Error("The EPUB has no eligible reading-order content documents");
  const prepared = { staging, packageFile, documents };
  await writeFile(join(root, "prepared.json"), JSON.stringify(prepared));
  return prepared;
}

export async function runPreparedBook(
  root: string,
  job: PersistedJob,
  update: (patch: Partial<PersistedJob>) => Promise<void>,
  signal?: AbortSignal,
) {
  // Assembly mutates staging documents. Re-extract the source on every run so a
  // retry can safely reuse completed model checkpoints without reinserting into
  // the output of an earlier run.
  const prepared = await prepareBook(root);
  const batches = prepared.documents.flatMap((document) => document.batches);
  const {
    useExternal,
    translation: translationProfile,
    editing: editingProfile,
    consistency: consistencyProfile,
  } = resolveProfiles();
  const provider = useExternal ? new DeepSeekProvider() : new FakeProvider();
  const instructions = job.instructions.trim();
  const sourceLanguage = providerLanguage(job.sourceLanguage),
    targetLanguage = providerLanguage(job.targetLanguage);
  const consistencyErrors: string[] = [];
  let generatedGlossary: GlossaryEntry[] = [];
  if (useExternal) {
    try {
      generatedGlossary = await resolveEntityRegistry(
        provider,
        consistencyProfile,
        sourceLanguage,
        targetLanguage,
        prepared.documents.map((document) => ({
          id: document.id,
          sourceSegments: document.segments,
          editedSegments: [],
        })),
        root,
        signal,
      );
    } catch (error) {
      consistencyErrors.push(
        `Entity registry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  const glossary = mergeGlossaries(job.glossary, generatedGlossary);
  let translated = 0,
    edited = 0;
  const result = await runTwoPass(batches, provider, {
    root,
    translationProfile,
    editingProfile,
    sourceLanguage,
    targetLanguage,
    instructions,
    glossary,
    signal,
    onProgress: async (stage) => {
      if (stage === "translation") translated++;
      else edited++;
      await update({
        stage,
        status: "running",
        progress: { ...job.progress, translated, edited, total: batches.length },
      });
    },
  });
  const consistencyDocuments: ConsistencyDocument[] = prepared.documents.map((document) => ({
    id: document.id,
    sourceSegments: document.segments,
    editedSegments: mergeChunkedSegments(
      document.batches.flatMap((batch) => result.edits.get(batch.id) ?? []),
    ),
  }));
  const mechanicalApplied =
    targetLanguage.tag.toLocaleLowerCase().split("-")[0] === "ru"
      ? normalizeRussianConsistencyMechanics(consistencyDocuments)
      : 0;
  const resolverReport = buildConsistencyReport(
    consistencyDocuments,
    glossary.filter(isGlossaryEntry),
  );
  let decisions: Awaited<ReturnType<typeof resolveConsistencyConflicts>> = [];
  let applied = 0;
  if (useExternal && resolverReport.entityEvidence.length) {
    try {
      decisions = await resolveConsistencyConflicts(
        provider,
        consistencyProfile,
        sourceLanguage,
        targetLanguage,
        resolverReport,
        root,
        signal,
      );
      applied = applyConsistencyDecisions(consistencyDocuments, decisions);
    } catch (error) {
      consistencyErrors.push(
        `Consistency resolver unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  const consistencyReport = buildConsistencyReport(
    consistencyDocuments,
    glossary.filter(isGlossaryEntry),
  );
  await writeFile(
    join(root, "consistency-report.json"),
    JSON.stringify(
      {
        ...consistencyReport,
        decisions,
        applied,
        mechanicalApplied,
        errors: consistencyErrors,
      },
      null,
      2,
    ),
  );
  if (consistencyReport.warningCount || consistencyErrors.length) {
    await update({
      warnings: job.warnings + consistencyReport.warningCount + consistencyErrors.length,
    });
  }
  for (const document of prepared.documents) {
    const editedDocument = consistencyDocuments.find((candidate) => candidate.id === document.id);
    const values = new Map(
      editedDocument?.editedSegments.map((segment) => [segment.id, segment.text]) ?? [],
    );
    const path = document.path,
      dom = parseXml(await readFile(path));
    reinsertText(dom, document.segments, values);
    updateContentLanguage(dom, targetLanguage.tag);
    await writeFile(path, serializeXml(dom));
  }
  const packageDom = parseXml(await readFile(prepared.packageFile));
  updatePackageLanguage(packageDom, targetLanguage.tag);
  await writeFile(prepared.packageFile, serializeXml(packageDom));
  await update({ stage: "building", status: "running" });
  const output = join(root, "output.epub"),
    temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await buildEpub(prepared.staging, temporary);
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const report = await validateEpubArchive(temporary);
    if (!report.ok) throw new Error(`Output validation failed: ${report.errors.join(", ")}`);
    const outputAudit = await auditEpubArchive(temporary, targetLanguage.tag);
    await writeFile(
      join(root, "output-consistency-audit.json"),
      JSON.stringify(outputAudit, null, 2),
    );
    report.warnings.push(...outputAudit.warnings);
    await rename(temporary, output);
    await syncParentDirectory(output);
    return report;
  } finally {
    await rm(temporary, { force: true });
  }
}
