import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRunManifest } from "../../src/server/jobs/run-manifest.js";

describe("run manifest", () => {
  it("summarizes reusable checkpoints without persisting book text", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-run-manifest-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "prepared.json"), "{}\n");
    await writeFile(join(root, "drafts.ndjson"), '{"batchId":"a"}\n{"batchId":"b"}\n');
    await writeFile(join(root, "edits.ndjson"), '{"batchId":"a"}\n');
    const manifest = await writeRunManifest(root, {
      version: 1,
      id: "job",
      title: "Book",
      sourceLanguage: "en",
      targetLanguage: "ru",
      status: "paused",
      stage: "editing",
      progress: { translated: 2, edited: 1, total: 3, failed: 0 },
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      sourceFingerprint: "abc",
      warnings: 0,
      instructions: "",
      glossary: [],
      qualityMode: "standard",
    });
    expect(manifest.recovery.eligible).toBe(true);
    expect(manifest.sourceFingerprint).toBe("abc");
    expect(manifest.preparationVersion).toBe(1);
    expect(manifest.units.translation).toEqual({ completed: 2, total: 3, pending: 1 });
    expect(manifest.units.editing).toEqual({ completed: 1, total: 3, pending: 2 });
    expect(await readFile(join(root, "run-manifest.json"), "utf8")).not.toContain("Book text");
  });
});
