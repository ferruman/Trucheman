import { describe, expect, it } from "vitest";
import {
  formatStyleProfile,
  sampleBookPassages,
} from "../../src/server/jobs/style-profile-service.js";
import type { ConsistencyDocument } from "../../src/server/jobs/consistency-service.js";

function book(texts: string[]): ConsistencyDocument[] {
  return [
    {
      id: "document-1",
      sourceSegments: texts.map((text, index) => ({
        id: `document-1#${index}`,
        text,
        path: [],
        kind: "text",
      })) as ConsistencyDocument["sourceSegments"],
      editedSegments: [],
    },
  ];
}

describe("sampleBookPassages", () => {
  it("skips short blocks and spreads picks across the whole book", () => {
    const passages = Array.from({ length: 120 }, (_, index) => `${index} `.padEnd(300, "x"));
    const sampled = sampleBookPassages(book(["Title", ...passages]));
    expect(sampled).toHaveLength(12);
    expect(sampled[0].startsWith("0 ")).toBe(true);
    // last pick comes from the back of the book, not the opening
    expect(Number(sampled.at(-1)!.split(" ")[0])).toBeGreaterThan(100);
  });

  it("stays inside the character budget", () => {
    const sampled = sampleBookPassages(book(Array.from({ length: 50 }, () => "y".repeat(4000))));
    expect(sampled.join("").length).toBeLessThanOrEqual(6000 + 1200);
    expect(sampled.every((text) => text.length <= 1200)).toBe(true);
  });

  it("returns nothing when the book has no prose blocks", () => {
    expect(sampleBookPassages(book(["Chapter 1", "The End"]))).toEqual([]);
  });
});

describe("formatStyleProfile", () => {
  it("drops empty fields and returns an empty block when nothing is usable", () => {
    expect(formatStyleProfile({ genre: "noir", tone: "  ", notes: ["keep it terse", " "] })).toBe(
      "Book style profile, derived from the source and binding for the whole book:\n- Genre: noir\n- keep it terse",
    );
    expect(formatStyleProfile({ notes: [] })).toBe("");
  });
});
