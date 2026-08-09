import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { literaryEditorCorpusSchema } from "../../src/server/evals/literary-editor-eval.js";
import { importLiteraryCorpusFromJob } from "../../src/server/evals/literary-corpus-import.js";

describe("literary corpus import", () => {
  it("aligns originals with the latest fixed drafts and samples deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "literary-import-"));
    const now = new Date().toISOString();
    await writeFile(
      join(root, "job.json"),
      JSON.stringify({
        version: 1,
        id: "12345678-1234-4234-8234-123456789012",
        title: "Sample Book",
        sourceLanguage: "en",
        targetLanguage: "ru",
        status: "ready",
        stage: "editing",
        progress: { translated: 2, edited: 2, total: 2, failed: 0 },
        createdAt: now,
        updatedAt: now,
        warnings: 0,
        documents: [],
        instructions: "",
        glossary: [],
        qualityMode: "standard",
      }),
    );
    const segments = [
      { id: "doc:1", text: "A".repeat(100) },
      { id: "doc:2", text: "B".repeat(400) },
      { id: "doc:3", text: "C".repeat(900) },
    ];
    await writeFile(join(root, "source.epub"), "fixture epub bytes");
    await writeFile(join(root, "prepared.json"), JSON.stringify({ documents: [{ segments }] }));
    await writeFile(
      join(root, "drafts.ndjson"),
      `${JSON.stringify({ segments: segments.map((segment) => ({ ...segment, text: `old-${segment.id}` })) })}\n${JSON.stringify({ segments: segments.map((segment) => ({ ...segment, text: `latest-${segment.id}` })) })}\n`,
    );

    const first = await importLiteraryCorpusFromJob(root, { limit: 3, seed: "fixed" });
    const second = await importLiteraryCorpusFromJob(root, { limit: 3, seed: "fixed" });

    expect(first).toEqual(second);
    expect(first.cases.map((item) => item.draft).sort()).toEqual([
      "latest-doc:1",
      "latest-doc:2",
      "latest-doc:3",
    ]);
    expect(first.cases.every((item) => item.requireChange === false)).toBe(true);
    expect(new Set(first.cases.map((item) => item.bookId)).size).toBe(1);
    expect(() => literaryEditorCorpusSchema.parse(first)).not.toThrow();
  });
});
