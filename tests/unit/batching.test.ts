import { describe, expect, it } from "vitest";
import { makeBatches, mergeChunkedSegments } from "../../src/server/epub/batcher.js";
describe("batching", () => {
  const segment = (id: string, text = "text") => ({
    id,
    text,
    sourceHash: "",
    locator: [0],
    leading: "",
    trailing: "",
  });

  it("keeps batches within the configured character budget", () => {
    const segments = Array.from({ length: 5 }, (_, i) => segment(`d:${i}`, "x".repeat(6)));
    const batches = makeBatches(segments, 10);
    expect(batches.length).toBe(5);
    expect(batches.flatMap((batch) => batch.segments)).toHaveLength(5);
  });

  it("limits batches containing many short segments", () => {
    const segments = Array.from({ length: 52 }, (_, i) => segment(`document-3:${i}`));
    const batches = makeBatches(segments);

    expect(batches.map((batch) => batch.segments.length)).toEqual([20, 20, 12]);
    expect(batches.flatMap((batch) => batch.segments)).toEqual(segments);
  });

  it("keeps every chunk of an oversized segment addressable and rejoinable", () => {
    const sentences = "Sentence one is here. ".repeat(1200);
    const batches = makeBatches([segment("document-1:0", sentences)]);
    const chunks = batches.flatMap((batch) => batch.segments);

    expect(chunks.length).toBeGreaterThan(1);
    // Reusing the bare id here is what silently dropped all but the last chunk.
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);

    const merged = mergeChunkedSegments(chunks.map(({ id, text }) => ({ id, text })));
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("document-1:0");
    expect(merged[0].text).toBe(sentences.trim());
  });

  it("leaves unsplit segments untouched when merging", () => {
    expect(
      mergeChunkedSegments([
        { id: "document-1:0", text: "first" },
        { id: "document-1:1", text: "second" },
      ]),
    ).toEqual([
      { id: "document-1:0", text: "first" },
      { id: "document-1:1", text: "second" },
    ]);
  });

  it("creates globally distinct checkpoint IDs for different documents", () => {
    const first = makeBatches([segment("document-1:0")]);
    const second = makeBatches([segment("document-2:0")]);
    expect(first[0].id).not.toBe(second[0].id);
    expect(first[0].documentId).toBe("document-1");
    expect(second[0].documentId).toBe("document-2");
  });
});
