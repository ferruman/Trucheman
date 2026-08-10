import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFragmentedFixtureEpub } from "../fixtures/build-epubs.js";
import { prepareBook, runPreparedBook } from "../../src/server/jobs/book-pipeline.js";
import { extractEpub } from "../../src/server/epub/extract.js";
import type { PersistedJob } from "../../src/server/domain/job.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fragmentedJobRoot() {
  const root = await mkdtemp(join(tmpdir(), "book-fragmented-"));
  roots.push(root);
  const source = await buildFragmentedFixtureEpub(join(root, "fixture.epub"));
  await copyFile(source, join(root, "source.epub"));
  return root;
}

const job: PersistedJob = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000000",
  title: "Fragmented",
  sourceLanguage: "en",
  targetLanguage: "ru",
  status: "running",
  stage: "translation",
  progress: { translated: 0, edited: 0, total: 0, failed: 0 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  instructions: "",
  glossary: [],
  warnings: 0,
  qualityMode: "standard",
};

describe("fragmented EPUB logical blocks", () => {
  it("sends each fragmented heading to the model as one unit", async () => {
    const root = await fragmentedJobRoot();
    const prepared = await prepareBook(root);
    const document = prepared.documents[0];

    // Nine one-word spans across three headings collapse into three headings.
    expect(document.units.map((unit) => unit.text)).toEqual([
      "In the Desert",
      "From the Land of the Farther Suns",
      "Part 5 Little Birds of the Night",
      "He said ",
      "nothing",
      " at all.",
    ]);
    // `<em>` boundaries survive: that paragraph is not merged.
    expect(document.segments.length).toBeGreaterThan(document.units.length);
    expect(Object.keys(document.absorbed)).toHaveLength(
      document.segments.length - document.units.length,
    );

    // A table-of-contents entry fragmented inside one <a> also rejoins.
    const nav = prepared.documents.find((candidate) => candidate.navigation === "nav");
    expect(nav?.units.map((unit) => unit.text)).toEqual(["Part 2. In the Desert"]);
    expect(prepared.documents.find((candidate) => candidate.navigation === "ncx")).toBeDefined();
  });

  it("reinserts a translated heading once, without duplicated fragments", async () => {
    const root = await fragmentedJobRoot();
    const translations = new Map([
      ["In the Desert", "В пустыне"],
      ["From the Land of the Farther Suns", "Из страны дальних солнц"],
      ["Part 5 Little Birds of the Night", "Часть 5. Ночные пташки"],
      ["Part 2. In the Desert", "Часть 2. В пустыне"],
    ]);
    const provider = {
      async complete(request: {
        mode: string;
        segments: Array<{ id: string; text?: string; original?: string; draft?: string }>;
      }) {
        return {
          segments: request.segments.map((segment) => {
            const input = segment.text ?? segment.draft ?? segment.original ?? "";
            return { id: segment.id, text: translations.get(input) ?? input };
          }),
          finishReason: "stop",
        };
      },
    };

    const report = await runPreparedBook(root, job, async () => {}, undefined, false, {
      provider,
      useExternal: false,
    });
    expect(report.ok).toBe(true);

    const extracted = await mkdtemp(join(tmpdir(), "book-fragmented-out-"));
    roots.push(extracted);
    await extractEpub(join(root, "output.epub"), extracted);
    const chapter = await readFile(join(extracted, "OEBPS/chapter.xhtml"), "utf8");

    expect(chapter).toContain("В пустыне");
    expect(chapter).toContain("Из страны дальних солнц");
    expect(chapter).toContain("Часть 5. Ночные пташки");
    // The regressions the fragmented markup used to produce.
    expect(chapter).not.toContain("В пустыне пустыня");
    expect(chapter).not.toContain("Из земли Земля");
    expect(chapter.replace(/<[^>]*>/g, " ").match(/В пустыне/g)).toHaveLength(1);
  });

  it("audits the built EPUB for duplicated fragments and TOC corruption", async () => {
    const root = await fragmentedJobRoot();
    const provider = {
      async complete(request: {
        segments: Array<{ id: string; text?: string; original?: string; draft?: string }>;
      }) {
        return {
          segments: request.segments.map((segment) => ({
            id: segment.id,
            text: `Текст ${segment.id}`,
          })),
          finishReason: "stop",
        };
      },
    };

    await runPreparedBook(root, job, async () => {}, undefined, false, {
      provider,
      useExternal: false,
    });
    const audit = JSON.parse(await readFile(join(root, "output-consistency-audit.json"), "utf8"));

    expect(audit.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("duplicated fragment")]),
    );
    expect(audit.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("translated document is empty")]),
    );
    // The NCX navMap is read as the authoritative source of table-of-contents labels.
    expect(audit.checks.tableOfContents).toHaveLength(1);
    expect(audit.checks.tableOfContents[0].duplicates).toEqual([]);
    expect(audit.checks.language.packageLanguage).toBe("ru");
  });

  it("makes the NCX label win over a divergent nav rendering", async () => {
    const root = await fragmentedJobRoot();
    // Same source label, deliberately different renderings: nav is document-2, NCX is
    // document-3, and only the NCX rendering may reach the built book.
    const byDocument: Record<string, string> = {
      "document-2": "Глава вторая. Среди песков",
      "document-3": "Часть 2. В пустыне",
    };
    const provider = {
      async complete(request: {
        segments: Array<{ id: string; text?: string; original?: string; draft?: string }>;
      }) {
        return {
          segments: request.segments.map((segment) => {
            const input = segment.text ?? segment.draft ?? segment.original ?? "";
            const rendering = byDocument[segment.id.split(":")[0]];
            return {
              id: segment.id,
              text: input.includes("In the Desert") && rendering ? rendering : input,
            };
          }),
          finishReason: "stop",
        };
      },
    };

    await runPreparedBook(root, job, async () => {}, undefined, false, {
      provider,
      useExternal: false,
    });
    const report = JSON.parse(await readFile(join(root, "consistency-report.json"), "utf8"));

    expect(report.navigationLabels.labels).toEqual([
      { source: "Part 2. In the Desert", canonical: "Часть 2. В пустыне" },
    ]);

    const extracted = await mkdtemp(join(tmpdir(), "book-nav-out-"));
    roots.push(extracted);
    await extractEpub(join(root, "output.epub"), extracted);
    const nav = await readFile(join(extracted, "OEBPS/toc.xhtml"), "utf8");

    expect(nav).toContain("Часть 2. В пустыне");
    expect(nav).not.toContain("Среди песков");
  });
});
