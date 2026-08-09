import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedJob } from "../../src/server/domain/job.js";
import { providerLanguage, runPreparedBook } from "../../src/server/jobs/book-pipeline.js";
import { buildFixtureEpub } from "../fixtures/build-epubs.js";
import { extractEpub } from "../../src/server/epub/extract.js";
import { parseXml } from "../../src/server/epub/xml-dom.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("book pipeline instructions", () => {
  it("builds structured provider language metadata", () => {
    expect(providerLanguage("en")).toEqual({ tag: "en", name: "English" });
    expect(providerLanguage("ru")).toEqual({ tag: "ru", name: "Russian" });
    expect(() => providerLanguage("unknown")).toThrow("Unsupported language");
  });

  it("rebuilds from a clean source and reuses checkpoints on repeated runs", async () => {
    vi.stubEnv("BOOK_TRANSLATOR_PROVIDER", "deterministic");
    const root = await mkdtemp(`${tmpdir()}/book-pipeline-rerun-`);
    roots.push(root);
    await buildFixtureEpub(join(root, "source.epub"));
    const now = new Date().toISOString();
    const job: PersistedJob = {
      version: 1,
      id: "12345678-1234-4234-8234-123456789012",
      title: "Book",
      sourceLanguage: "en",
      targetLanguage: "ru",
      status: "ready",
      stage: "translation",
      progress: { translated: 0, edited: 0, total: 1, failed: 0 },
      createdAt: now,
      updatedAt: now,
      warnings: 0,
      documents: [],
      instructions: "",
      glossary: [],
    };
    await runPreparedBook(root, job, async () => undefined);
    const firstDrafts = await readFile(join(root, "drafts.ndjson"), "utf8"),
      firstEdits = await readFile(join(root, "edits.ndjson"), "utf8");
    await expect(runPreparedBook(root, job, async () => undefined)).resolves.toMatchObject({
      ok: true,
    });
    expect(await readFile(join(root, "drafts.ndjson"), "utf8")).toBe(firstDrafts);
    expect(await readFile(join(root, "edits.ndjson"), "utf8")).toBe(firstEdits);
  });

  it("localizes EPUB metadata and both EPUB 3 and EPUB 2 navigation", async () => {
    vi.stubEnv("BOOK_TRANSLATOR_PROVIDER", "deterministic");
    const root = await mkdtemp(`${tmpdir()}/book-pipeline-navigation-`);
    roots.push(root);
    await buildFixtureEpub(join(root, "source.epub"));
    const now = new Date().toISOString();
    const job: PersistedJob = {
      version: 1,
      id: "12345678-1234-4234-8234-123456789012",
      title: "Book",
      sourceLanguage: "en",
      targetLanguage: "ru",
      status: "ready",
      stage: "translation",
      progress: { translated: 0, edited: 0, total: 3, failed: 0 },
      createdAt: now,
      updatedAt: now,
      warnings: 0,
      documents: [],
      instructions: "",
      glossary: [],
    };

    await runPreparedBook(root, job, async () => undefined);
    const extracted = join(root, "localized-output");
    await extractEpub(join(root, "output.epub"), extracted);
    const packageXml = await readFile(join(extracted, "OEBPS/content.opf"), "utf8");
    const chapter = parseXml(await readFile(join(extracted, "OEBPS/chapter.xhtml"), "utf8"));
    const nav = parseXml(await readFile(join(extracted, "OEBPS/toc.xhtml"), "utf8"));
    const ncx = parseXml(await readFile(join(extracted, "OEBPS/toc.ncx"), "utf8"));

    expect(packageXml).toMatch(/<dc:language>ru<\/dc:language>/);
    expect(chapter.documentElement.getAttribute("lang")).toBe("ru");
    expect(chapter.documentElement.getAttribute("xml:lang")).toBe("ru");
    expect(nav.documentElement.getAttribute("lang")).toBe("ru");
    expect(nav.documentElement.textContent).toContain("[translated] The call of Cthulhu");
    expect(nav.getElementsByTagName("a").item(0)?.getAttribute("href")).toBe("chapter.xhtml");
    expect(ncx.documentElement.getAttribute("xml:lang")).toBe("ru");
    expect(ncx.documentElement.textContent).toContain("[translated] The CALL of CTHULHU");
    expect(ncx.getElementsByTagName("content").item(0)?.getAttribute("src")).toBe("chapter.xhtml");
  });
});
