import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractEpub } from "../epub/extract.js";
import { parseContainer, parsePackage } from "../epub/package-parser.js";
import {
  batchCharBudget,
  batchSegmentCap,
  makeBatches,
  mergeChunkedSegments,
  type Batch,
} from "../epub/batcher.js";
import {
  extractTextSegments,
  mergeLogicalBlocks,
  reinsertText,
  type TextSegment,
} from "../epub/text-segments.js";
import { parseXml, serializeXml } from "../epub/xml-dom.js";
import { buildEpub } from "../epub/build.js";
import { auditEpubArchive } from "../epub/consistency-audit.js";
import {
  epubCheckErrors,
  persistEpubCheckResult,
  runOptionalEpubCheck,
} from "../epub/epubcheck.js";
import { resolveEpubPath, validateEpubArchive } from "../epub/validate.js";
import { updateContentLanguage, updatePackageLanguage } from "../epub/localization.js";
import { repairInvalidParagraphNesting } from "../epub/repair.js";
import { horizontalizePackage, isJapanese, normalizeJapaneseContent } from "../epub/japanese.js";
import type { LanguageModelProvider } from "../providers/provider.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { resolveProfiles } from "../config/profiles.js";
import { targetLanguageProfile } from "../config/target-language.js";
import { LANGUAGES } from "../../shared/languages.js";
import { buildSegmentScanReport, runQualityPipeline, type RunnerStage } from "./job-runner.js";
import { scanSegment, type SegmentDefect } from "./segment-scan.js";
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
import { formatChapterCard, resolveChapterCards } from "./chapter-card-service.js";
import {
  applySelectiveRepairs,
  buildQualityAuditSegments,
  buildRepairSegments,
  repairBatch,
  type QualityFinding,
} from "./quality-service.js";

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
export type PreparedBook = {
  staging: string;
  packageFile: string;
  documents: PreparedDocument[];
  /** Written text → its furigana reading, harvested from ruby before it was flattened. */
  readings?: Record<string, string>;
};

async function repairFinalSourceInterference(
  documents: ConsistencyDocument[],
  provider: LanguageModelProvider,
  profile: ReturnType<typeof resolveProfiles>["repair"],
  sourceLanguage: ReturnType<typeof providerLanguage>,
  targetLanguage: ReturnType<typeof providerLanguage>,
  instructions: string,
  glossary: unknown[],
  signal?: AbortSignal,
) {
  let attempted = 0;
  let changed = 0;
  let rejected = 0;
  let failed = 0;
  for (const document of documents) {
    const auditInputs = buildQualityAuditSegments(
      document.sourceSegments,
      document.editedSegments,
      document.editedSegments,
    );
    const findings: QualityFinding[] = [];
    const editedById = new Map(
      document.editedSegments.map((segment) => [segment.id, segment.text]),
    );
    for (const source of document.sourceSegments) {
      const defects = scanSegment(
        source.text,
        editedById.get(source.id) ?? "",
        source.id,
        targetLanguage.tag,
      ).filter((defect) => defect.kind === "source_interference" || defect.kind === "untranslated");
      if (!defects.length) continue;
      findings.push({
        id: source.id,
        rejectedIssues: 0,
        issues: defects.flatMap((defect) =>
          (defect.spans ?? [editedById.get(source.id) ?? ""]).map((span) => ({
            span,
            type: "source_language_interference" as const,
            severity: "high" as const,
            reason:
              defect.kind === "untranslated"
                ? "The final block is still in the source language. Translate it completely."
                : `The source-language word "${span}" remains inside the final translation. Translate it.`,
          })),
        ),
      });
    }
    const inputs = buildRepairSegments(auditInputs, findings);
    if (!inputs.length) continue;
    attempted += inputs.length;
    try {
      const first = await repairBatch(
        provider,
        profile,
        inputs,
        { sourceLanguage, targetLanguage },
        [
          instructions,
          "This is the final correctness gate. Replace every listed source-language residue; do not return a flagged block unchanged.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        glossary,
        signal,
      );
      let repairs = first.result.segments;
      const repairById = new Map(repairs.map((segment) => [segment.id, segment]));
      const unchanged = inputs.filter(
        (input) => repairById.get(input.id)?.text === input.editedTranslation,
      );
      if (unchanged.length) {
        const retry = await repairBatch(
          provider,
          profile,
          unchanged,
          { sourceLanguage, targetLanguage },
          "Translate the exact flagged source-language spans now. Return a concretely changed target-language block for every input.",
          glossary,
          signal,
        );
        for (const segment of retry.result.segments) repairById.set(segment.id, segment);
        repairs = inputs.flatMap((input) => {
          const replacement = repairById.get(input.id);
          return replacement ? [replacement] : [];
        });
      }
      const before = new Map(document.editedSegments.map((segment) => [segment.id, segment.text]));
      const reviewed = applySelectiveRepairs(document.editedSegments, repairs, inputs);
      document.editedSegments = reviewed.segments;
      rejected += reviewed.rejected.length;
      changed += reviewed.segments.filter(
        (segment) => before.get(segment.id) !== segment.text,
      ).length;
    } catch (error) {
      if (signal?.aborted) throw error;
      failed += inputs.length;
    }
  }
  return { attempted, changed, rejected, failed };
}

export function providerLanguage(tag: string) {
  const language = LANGUAGES.find((candidate) => candidate.tag === tag);
  if (!language) throw new Error(`Unsupported language: ${tag}`);
  return { tag: language.tag, name: language.name };
}

export async function prepareBook(root: string, sourceLanguage?: string): Promise<PreparedBook> {
  const staging = join(root, "staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await extractEpub(join(root, "source.epub"), staging);
  const packagePath = parseContainer(
    await readFile(join(staging, "META-INF/container.xml"), "utf8"),
  );
  const packageFile = resolveEpubPath(staging, packagePath);
  const bookPackage = parsePackage(await readFile(packageFile, "utf8"), packagePath);
  // Japanese books are typeset vertically, page backwards and gloss their kanji. All three are
  // properties of the original text, not of the translation, so they are undone in staging
  // before anything is segmented — reinsertion and assembly then need to know nothing about it.
  const japanese = isJapanese(sourceLanguage);
  const readings = new Map<string, string>();
  if (japanese) {
    const packageDom = parseXml(await readFile(packageFile));
    if (horizontalizePackage(packageDom)) await writeFile(packageFile, serializeXml(packageDom));
  }
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
    const dom = parseXml(await readFile(path));
    let rewritten = repairInvalidParagraphNesting(dom) > 0;
    if (japanese) rewritten = normalizeJapaneseContent(dom, readings) || rewritten;
    if (rewritten) await writeFile(path, serializeXml(dom));
    const segments = extractTextSegments(dom, documentId);
    const { units, absorbed } = mergeLogicalBlocks(segments);
    const ncx = /x-dtbncx/i.test(item.mediaType);
    documents.push({
      id: documentId,
      path,
      title: id,
      segments,
      units,
      absorbed: Object.fromEntries(absorbed),
      batches: makeBatches(units, batchCharBudget(sourceLanguage), batchSegmentCap(sourceLanguage)),
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
  const prepared: PreparedBook = {
    staging,
    packageFile,
    documents,
    ...(readings.size ? { readings: Object.fromEntries(readings) } : {}),
  };
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
  const prepared = await prepareBook(root, job.sourceLanguage);
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
    repair: repairProfile,
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
  /** Preflight passes that failed. They do not hold the book back, but they are not silent. */
  let preflightWarnings = 0;
  // Preflight is minutes of provider calls with no batch to count, so without this the job
  // sits at "running, 0/N" long enough to look hung. The stage is honest: this is analysis.
  const preflight = (label: string) =>
    update({ status: "running", stage: "analysis", currentDocument: label });
  let styleBlock = "";
  if (useExternal) {
    try {
      await preflight("Preflight: style profile");
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
      preflightWarnings++;
    }
  }
  const instructions = [job.instructions.trim(), styleBlock].filter(Boolean).join("\n\n");
  let generatedGlossary: GlossaryEntry[] = [];
  if (useExternal) {
    try {
      await preflight("Preflight: glossary");
      const registry = await resolveEntityRegistry(
        provider,
        consistencyProfile,
        sourceLanguage,
        targetLanguage,
        sourceDocuments,
        root,
        signal,
        undefined,
        (done, total) => preflight(`Preflight: glossary ${done}/${total}`),
        prepared.readings,
      );
      generatedGlossary = registry.entries;
      for (const failure of registry.failedChunks)
        consistencyErrors.push(`Entity registry chunk ${failure.chunk} failed: ${failure.error}`);
    } catch (error) {
      // Advisory like the two preflights around it, and like them, pausing must still pause:
      // swallowing the abort here let a paused run carry on with an empty generated glossary
      // and translate the whole book without it.
      if (signal?.aborted) throw error;
      consistencyErrors.push(
        `Entity registry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  const glossary = mergeGlossaries(job.glossary, generatedGlossary);
  // The merged set is what the run actually translated against, and it is the only place the
  // generated entries survive as finished glossary rows — the registry cache holds raw model
  // answers. A later book carries this file over rather than paying to rediscover the names.
  await atomicJson(join(root, "glossary.json"), { entries: glossary });
  const chapterCards = new Map<string, string>();
  if (useExternal) {
    try {
      await preflight("Preflight: chapter cards");
      const resolved = await resolveChapterCards(
        provider,
        consistencyProfile,
        sourceLanguage,
        targetLanguage,
        sourceDocuments,
        root,
        signal,
        concurrency,
        (done, total) => preflight(`Preflight: chapter cards ${done}/${total}`),
      );
      // Counted once, as a consistency error below — adding it here too reported one failed
      // card as two warnings.
      // A chapter without its card is translated without the gender, number and address
      // register its blocks cannot recover on their own. That is the kind of thing this run
      // shipped without, so it belongs with the reasons — a count alone still reported the
      // book as cleanly completed.
      if (resolved.failed)
        consistencyErrors.push(`${resolved.failed} chapter(s) translated without a chapter card`);
      for (const [id, card] of resolved.cards) {
        const block = formatChapterCard(card);
        if (block) chapterCards.set(id, block);
      }
    } catch (error) {
      // Advisory, like the style profile: a chapter without a card still translates, so this
      // is a warning to look at rather than a reason to hold the book back.
      if (signal?.aborted) throw error;
      preflightWarnings++;
    }
  }
  // Hand the stage back explicitly: a run whose batches are all cached never calls onStage,
  // and would otherwise still read "analysis" while it builds the book.
  if (useExternal)
    await update({ status: "running", stage: "translation", currentDocument: undefined });
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
  const result = await runQualityPipeline(batches, provider, {
    root,
    translationProfile,
    editingProfile,
    criticProfile,
    repairProfile,
    sourceLanguage,
    targetLanguage,
    instructions,
    chapterCards,
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
  // One warning per defective segment, not per defect: a block with three findings is still
  // one thing to look at. Every term below is recomputed over the whole book on every run,
  // cached batches included, so this replaces the count rather than adding to it — a resumed
  // run used to report the book's warnings on top of the previous run's, and 48 read as 104.
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
  // The consistency resolver is the last model allowed to rewrite book text. Give any
  // high-confidence source-language leak in that actual final text one focused repair pass;
  // previously these were detected only after every repair opportunity had already ended.
  const finalRepair = await repairFinalSourceInterference(
    consistencyDocuments,
    provider,
    repairProfile,
    sourceLanguage,
    targetLanguage,
    instructions,
    glossary,
    signal,
  );
  // Consistency mutates the text after the quality runner's scan. Scan its actual output so
  // an introduced quote, omission, or source-language word cannot ship after the last gate.
  const batchBySegment = new Map(
    prepared.documents.flatMap((document) =>
      document.batches.flatMap((batch) => batch.segments.map((segment) => [segment.id, batch.id])),
    ),
  );
  const finalScanDefects: Array<SegmentDefect & { batchId: string }> = [];
  for (const document of consistencyDocuments) {
    const edited = new Map(document.editedSegments.map((segment) => [segment.id, segment.text]));
    for (const source of document.sourceSegments) {
      for (const defect of scanSegment(
        source.text,
        edited.get(source.id) ?? "",
        source.id,
        targetLanguage.tag,
      )) {
        finalScanDefects.push({ batchId: batchBySegment.get(source.id) ?? document.id, ...defect });
      }
    }
  }
  const qualityPath = join(root, "quality-report.json");
  const qualityReport = JSON.parse(await readFile(qualityPath, "utf8"));
  qualityReport.version = 6;
  qualityReport.scan = buildSegmentScanReport(finalScanDefects);
  qualityReport.scanStage = "post_consistency";
  qualityReport.postConsistencyRepair = finalRepair;
  await atomicJson(qualityPath, qualityReport);
  const runWarnings =
    preflightWarnings +
    result.qualityAuditErrors +
    result.failedRepairs.length +
    new Set(finalScanDefects.filter((defect) => defect.kind !== "source_residue").map((d) => d.id))
      .size +
    new Set(
      [...result.rejectedRepairs, ...result.unrepairedSegments].map(
        (item) => `${item.batchId}\0${item.id}`,
      ),
    ).size;
  const warningCount =
    consistencyReport.warningCount +
    consistencyReport.errors.length +
    consistencyReport.ignoredGlossaryEntries.length;
  await update({ warnings: runWarnings + warningCount });
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
  const builtAt = new Date();
  const packageDom = parseXml(await readFile(prepared.packageFile));
  updatePackageLanguage(packageDom, targetLanguage.tag, builtAt);
  await writeFile(prepared.packageFile, serializeXml(packageDom));
  await update({ stage: "building", status: "running" });
  const output = join(root, "output.epub"),
    temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await buildEpub(prepared.staging, temporary, builtAt);
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
    await rename(temporary, output);
    await syncParentDirectory(output);
    // Conformance gate, when EPUBCheck is installed. It reports, it does not reject: a book
    // whose source was already non-conformant would otherwise be untranslatable here — so
    // running it after the rename costs nothing and is the only way it runs at all.
    // EPUBCheck refuses any path not ending in `.epub` ("Mode required for non-epub files"),
    // and that refusal is not an ERROR line, so pointing it at the `.tmp` silently passed.
    // A minute is enough for a novel; a hang must not hold the job at 99%.
    const epubCheck = await runOptionalEpubCheck(output, 120000);
    await persistEpubCheckResult(root, epubCheck);
    if (!epubCheck.ok) {
      report.warnings.push(...epubCheckErrors(epubCheck.output));
    }
    // A built file is still downloadable, but it is not a clean completion while the final
    // correctness scan or an available conformance checker reports a hard defect.
    const residualDefects = new Set(
      finalScanDefects
        .filter((defect) => defect.kind !== "source_residue" && defect.kind !== "missing_numbers")
        .map((defect) => defect.id),
    ).size;
    const degraded = [...consistencyErrors];
    if (residualDefects)
      degraded.push(`${residualDefects} segment(s) failed the final correctness scan`);
    if (epubCheck.available && !epubCheck.ok)
      degraded.push(
        `EPUBCheck found ${epubCheck.counts.fatal + epubCheck.counts.error} conformance error(s)`,
      );
    return { ...report, degraded };
  } finally {
    await rm(temporary, { force: true });
  }
}
