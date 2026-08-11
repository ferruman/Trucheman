import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedJob } from "../../src/server/domain/job.js";
import { providerLanguage, runPreparedBook } from "../../src/server/jobs/book-pipeline.js";
import { buildFixtureEpub } from "../fixtures/build-epubs.js";
import { extractEpub } from "../../src/server/epub/extract.js";
import { parseXml } from "../../src/server/epub/xml-dom.js";
import { FakeProvider } from "../../src/server/providers/fake-provider.js";
import type { LanguageModelProvider } from "../../src/server/providers/provider.js";

// These run the whole pipeline over a real fixture EPUB. Alone they take a few seconds; sharing
// the machine with the rest of the suite pushed them past the 5s default, so the file went red
// at random on a full run and green in isolation.
vi.setConfig({ testTimeout: 30000 });

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
      qualityMode: "standard",
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

  it("reports the oldest open batch so concurrent workers cannot rewind the progress", async () => {
    vi.stubEnv("BOOK_TRANSLATOR_PROVIDER", "deterministic");
    vi.stubEnv("BOOK_TRANSLATOR_CONCURRENCY", "4");
    const root = await mkdtemp(`${tmpdir()}/book-pipeline-frontier-`);
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
      qualityMode: "standard",
    };
    const fake = new FakeProvider();
    // Uneven but fixed latency, so the workers finish out of the order they started in and
    // do so the same way every run. With a random delay the first batch was the last to
    // close about one run in four; the frontier then legitimately never advanced past its
    // document, and the test failed on a correct result.
    const latencies = [20, 5, 30, 10, 25, 15];
    let call = 0;
    const provider: LanguageModelProvider = {
      async complete(request, signal) {
        const delay = latencies[call++ % latencies.length];
        await new Promise((resolve) => setTimeout(resolve, delay));
        return fake.complete(request, signal);
      },
    };
    const reported: string[] = [];

    await runPreparedBook(
      root,
      job,
      async (patch) => {
        if (patch.currentDocument) reported.push(patch.currentDocument);
      },
      undefined,
      false,
      { provider },
    );

    expect(new Set(reported).size).toBeGreaterThan(1);
    // A document is never reported again after a later one: the run only moves forward.
    const firstSeen = reported.map((title) => reported.indexOf(title));
    expect(firstSeen).toEqual([...firstSeen].sort((a, b) => a - b));
  });

  it("pauses when the abort lands in the glossary preflight", async () => {
    vi.stubEnv("BOOK_TRANSLATOR_PROVIDER", "deterministic");
    const root = await mkdtemp(`${tmpdir()}/book-pipeline-preflight-abort-`);
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
      qualityMode: "standard",
    };
    const controller = new AbortController();
    // Advisory preflight, so a style profile that fails is only a warning and the run goes on
    // to the glossary — where the pause lands. Swallowing it there translated the whole book
    // without its glossary and reported the run as completed.
    const provider: LanguageModelProvider = {
      async complete() {
        throw new Error("provider unavailable");
      },
    };

    const reported: string[] = [];

    await expect(
      runPreparedBook(
        root,
        job,
        async (patch) => {
          if (patch.currentDocument) reported.push(patch.currentDocument);
          if (patch.currentDocument !== "Preflight: glossary") return;
          controller.abort(new Error("Job paused"));
          throw controller.signal.reason;
        },
        controller.signal,
        false,
        { provider, useExternal: true },
      ),
    ).rejects.toThrow("Job paused");

    // The later preflight aborts too, so rejecting proves nothing on its own: what proves the
    // pause took is that the run never reached it.
    expect(reported).toEqual(["Preflight: style profile", "Preflight: glossary"]);
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
      qualityMode: "standard",
    };

    await runPreparedBook(root, job, async () => undefined);
    const extracted = join(root, "localized-output");
    await extractEpub(join(root, "output.epub"), extracted);
    const packageXml = await readFile(join(extracted, "OEBPS/content.opf"), "utf8");
    const chapter = parseXml(await readFile(join(extracted, "OEBPS/chapter.xhtml"), "utf8"));
    const nav = parseXml(await readFile(join(extracted, "OEBPS/toc.xhtml"), "utf8"));
    const ncx = parseXml(await readFile(join(extracted, "OEBPS/toc.ncx"), "utf8"));

    expect(packageXml).toMatch(/<dc:language>ru<\/dc:language>/);
    expect(parseXml(packageXml).documentElement.getAttribute("xml:lang")).toBe("ru");
    expect(chapter.documentElement.getAttribute("lang")).toBe("ru");
    expect(chapter.documentElement.getAttribute("xml:lang")).toBe("ru");
    expect(chapter.getElementsByTagName("header").item(0)?.getAttribute("lang")).toBe("ru");
    expect(nav.documentElement.getAttribute("lang")).toBe("ru");
    expect(nav.documentElement.textContent).toContain("[translated] The call of Cthulhu");
    expect(nav.getElementsByTagName("a").item(0)?.getAttribute("href")).toBe("chapter.xhtml");
    expect(ncx.documentElement.getAttribute("xml:lang")).toBe("ru");
    expect(ncx.documentElement.textContent).toContain("[translated] The CALL of CTHULHU");
    expect(ncx.getElementsByTagName("content").item(0)?.getAttribute("src")).toBe("chapter.xhtml");

    const outputAudit = JSON.parse(
      await readFile(join(root, "output-consistency-audit.json"), "utf8"),
    );
    expect(outputAudit.checks.language.packageLanguage).toBe("ru");
    expect(outputAudit.checks.language.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lang: "ru", xmlLang: "ru", matches: true }),
      ]),
    );
    expect(outputAudit.warnings).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/language/i)]),
    );
  });
});
