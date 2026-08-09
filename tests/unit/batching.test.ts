import { describe, expect, it } from "vitest";
import { makeBatches } from "../../src/server/epub/batcher.js";
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

  it("creates globally distinct checkpoint IDs for different documents", () => {
    const first = makeBatches([segment("document-1:0")]);
    const second = makeBatches([segment("document-2:0")]);
    expect(first[0].id).not.toBe(second[0].id);
    expect(first[0].documentId).toBe("document-1");
    expect(second[0].documentId).toBe("document-2");
  });
});
