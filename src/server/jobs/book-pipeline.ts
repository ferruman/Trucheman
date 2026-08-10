import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractEpub } from "../epub/extract.js";
import { parseContainer, parsePackage } from "../epub/package-parser.js";
import { makeBatches, mergeChunkedSegments, type Batch } from "../epub/batcher.js";
import {
  extractTextSegments,
  mergeLogicalBlocks,
  reinsertText,
  type TextSegment,
} from "../epub/text-segments.js";
import { parseXml, serializeXml } from "../epub/xml-dom.js";
import { buildEpub } from "../epub/build.js";
import { auditEpubArchive } from "../epub/consistency-audit.js";
import { epubCheckErrors, runOptionalEpubCheck } from "../epub/epubcheck.js";
import { resolveEpubPath, validateEpubArchive } from "../epub/validate.js";
import { updateContentLanguage, updatePackageLanguage } from "../epub/localization.js";
import type { LanguageModelProvider } from "../providers/provider.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { resolveProfiles } from "../config/profiles.js";
import { targetLanguageProfile } from "../config/target-language.js";
import { LANGUAGES } from "../../shared/languages.js";
import { runTwoPass, type RunnerStage } from "./job-runner.js";
import { UsageTrackingProvider } from "./usage-service.js";
import type { PersistedJob } from "../domain/job.js";
import { atomicJson, syncParentDirectory } from "../storage/atomic-file.js";
import {
  mergeGlossaries,
  resolveEntityRegistry,
  runConsistencyPass,
  type ConsistencyDocument,
  type GlossaryEntry,
} from "./consistency-service.js";
import { formatStyleProfile, resolveStyleProfile } from "./style-profile-service.js";

export type PreparedDocument = {
  id: string;
  path: string;
  title: string;
  /** Every source text node, needed to reinsert into the exact DOM positions. */
  segments: TextSegment[];
  /** Logical blocks: the units actually sent to the models. */
  units: TextSegment[];
  /** Segment id → the unit id that absorbed its text; these reinsert as empty. */
  absorbed: Record<string, string>;
  batches: Batch[];
  /** Navigation role, if any. The NCX navMap is the authority for TOC labels. */
  navigation: "ncx" | "nav" | null;
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
    const { units, absorbed } = mergeLogicalBlocks(segments);
    const ncx = /x-dtbncx/i.test(item.mediaType);
    documents.push({
      id: documentId,
      path,
      title: id,
      segments,
      units,
      absorbed: Object.fromEntries(absorbed),
      batches: makeBatches(units),
      navigation:
        ncx || Boolean(item.properties?.split(/\s+/).includes("nav"))
          ? ncx
            ? "ncx"
            : "nav"
          : null,
    });
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
  recoverCompatibleCheckpoints = false,
  /** Test seam: run the real pipeline against a stub model instead of a paid provider. */
  overrides?: { provider?: LanguageModelProvider; useExternal?: boolean },
) {
  // Assembly mutates staging documents. Re-extract the source on every run so a
  // retry can safely reuse completed model checkpoints without reinserting into
  // the output of an earlier run.
  const prepared = await prepareBook(root);
  const batches = prepared.documents.flatMap((document) => document.batches);
  const documentTitles = new Map(
    prepared.documents.map((document) => [document.id, document.title]),
  );
  const {
    useExternal: resolvedUseExternal,
    postRepairAudit,
    concurrency,
    translation: translationProfile,
    editing: editingProfile,
    critic: criticProfile,
    consistency: consistencyProfile,
  } = resolveProfiles();
  const useExternal = overrides?.useExternal ?? resolvedUseExternal;
  const provider = new UsageTrackingProvider(
    overrides?.provider ?? (resolvedUseExternal ? new DeepSeekProvider() : new FakeProvider()),
    root,
  );
  const sourceLanguage = providerLanguage(job.sourceLanguage),
    targetLanguage = providerLanguage(job.targetLanguage);
  const sourceDocuments = prepared.documents.map((document) => ({
    id: document.id,
    sourceSegments: document.units,
    editedSegments: [],
  }));
  const consistencyErrors: string[] = [];
  let styleBlock = "";
  if (useExternal) {
    try {
      const styleProfile = await resolveStyleProfile(
        provider,
        consistencyProfile,
        sourceLanguage,
        targetLanguage,
        sourceDocuments,
        root,
        signal,
      );
      styleBlock = styleProfile ? formatStyleProfile(styleProfile) : "";
    } catch (error) {
      // Advisory: a book without a style profile still translates. Pausing must still pause.
      if (signal?.aborted) throw error;
    }
  }
  const instructions = [job.instructions.trim(), styleBlock].filter(Boolean).join("\n\n");
  let generatedGlossary: GlossaryEntry[] = [];
  if (useExternal) {
    try {
      const registry = await resolveEntityRegistry(
        provider,
        consistencyProfile,
        sourceLanguage,
        targetLanguage,
        sourceDocuments,
        root,
        signal,
      );
      generatedGlossary = registry.entries;
      for (const failure of registry.failedChunks)
        consistencyErrors.push(`Entity registry chunk ${failure.chunk} failed: ${failure.error}`);
    } catch (error) {
      consistencyErrors.push(
        `Entity registry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  const glossary = mergeGlossaries(job.glossary, generatedGlossary);
  let translated = job.progress.translated,
    edited = job.progress.edited;
  // Concurrent batches would otherwise make the reported stage and chapter flicker between
  // whichever worker called last. Report the oldest batch still open instead: that is the one
  // the book is actually waiting on, and it only ever moves forward.
  const batchOrder = new Map(batches.map((batch, index) => [batch.id, index]));
  const active = new Map<string, RunnerStage>();
  const frontier = () => {
    let oldest: string | undefined;
    for (const id of active.keys())
      if (oldest === undefined || batchOrder.get(id)! < batchOrder.get(oldest)!) oldest = id;
    return oldest === undefined
      ? {}
      : {
          stage: active.get(oldest),
          currentDocument: documentTitles.get(batches[batchOrder.get(oldest)!].documentId),
        };
  };
  const result = await runTwoPass(batches, provider, {
    root,
    translationProfile,
    editingProfile,
    criticProfile,
    sourceLanguage,
    targetLanguage,
    instructions,
    glossary,
    qualityMode: job.qualityMode,
    postRepairAudit: job.qualityMode === "high" && postRepairAudit,
    concurrency,
    signal,
    recoverCompatibleCheckpoints,
    onStage: async (stage, batch) => {
      active.set(batch.id, stage);
      await update({ status: "running", ...frontier() });
    },
    onProgress: async (stage, batch, cached) => {
      active.set(batch.id, stage);
      if (cached) return;
      if (stage === "translation") translated++;
      else if (stage === "editing") edited++;
      await update({
        status: "running",
        ...frontier(),
        progress: { ...job.progress, translated, edited, total: batches.length },
      });
    },
    onBatchDone: (batch) => {
      active.delete(batch.id);
    },
  });
  if (result.qualityAuditErrors) {
    await update({ warnings: job.warnings + result.qualityAuditErrors });
  }
  const consistencyDocuments: ConsistencyDocument[] = prepared.documents.map((document) => ({
    id: document.id,
    sourceSegments: document.units,
    editedSegments: mergeChunkedSegments(
      document.batches.flatMap((batch) => result.edits.get(batch.id) ?? []),
    ),
  }));
  const targetRules = targetLanguageProfile(targetLanguage.tag);
  const consistencyReport = await runConsistencyPass({
    documents: consistencyDocuments,
    navigation: new Map(prepared.documents.map((document) => [document.id, document.navigation])),
    glossary,
    sourceLanguage,
    targetLanguage,
    mechanics: targetRules.mechanics,
    nameEndings: targetRules.nameEndings,
    provider,
    profile: consistencyProfile,
    root,
    useExternal,
    signal,
    errors: consistencyErrors,
  });
  consistencyErrors.splice(0, consistencyErrors.length, ...consistencyReport.errors);
  await atomicJson(join(root, "consistency-report.json"), consistencyReport);
  const warningCount =
    consistencyReport.warningCount +
    consistencyReport.errors.length +
    consistencyReport.ignoredGlossaryEntries.length;
  if (warningCount) {
    await update({ warnings: job.warnings + result.qualityAuditErrors + warningCount });
  }
  for (const document of prepared.documents) {
    const editedDocument = consistencyDocuments.find((candidate) => candidate.id === document.id);
    const values = new Map(
      editedDocument?.editedSegments.map((segment) => [segment.id, segment.text]) ?? [],
    );
    // Text nodes merged into a logical block are emptied; their unit carries the whole block.
    for (const absorbedId of Object.keys(document.absorbed)) values.set(absorbedId, "");
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
    await atomicJson(join(root, "output-consistency-audit.json"), outputAudit);
    report.warnings.push(...outputAudit.warnings);
    // Conformance gate, when EPUBCheck is installed. It reports, it does not reject: a book
    // whose source was already non-conformant would otherwise be untranslatable here.
    // A minute is enough for a novel; a hang must not hold the job at 99%.
    const epubCheck = await runOptionalEpubCheck(temporary, 120000);
    if (!epubCheck.ok) {
      await writeFile(join(root, "epubcheck.txt"), epubCheck.output);
      report.warnings.push(...epubCheckErrors(epubCheck.output));
    }
    await rename(temporary, output);
    await syncParentDirectory(output);
    // The book is built, but a failed consistency pass means it shipped unresolved name
    // variants. Reporting that as a clean completion is how a 50/50 name split went unseen.
    return { ...report, degraded: consistencyErrors };
  } finally {
    await rm(temporary, { force: true });
  }
}
