import { describe, expect, it } from "vitest";
import { makeBatches } from "../../src/server/epub/batcher.js";
describe("bounded batching", () =>
  it("handles many segments without changing order", () => {
    const segments = Array.from({ length: 1000 }, (_, i) => ({
      id: `d:${i}`,
      text: "text",
      sourceHash: "",
      locator: [i],
      leading: "",
      trailing: "",
    }));
    const result = makeBatches(segments, 100);
    expect(result.flatMap((x) => x.segments).map((x) => x.id)).toEqual(segments.map((x) => x.id));
  }));
