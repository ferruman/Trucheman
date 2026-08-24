import { describe, expect, it } from "vitest";
import {
  buildBlindReviewData,
  buildLiteraryReviewHtml,
  candidateOrder,
  comparisonFingerprint,
  summarizeLiteraryReview,
  type LiteraryComparisonReport,
} from "../../src/server/evals/literary-review.js";

const report: LiteraryComparisonReport = {
  createdAt: "2026-08-09T12:00:00.000Z",
  promptVersions: ["literary-v3.1", "literary-v3.2.1"],
  results: [
    {
      id: "case-1",
      genre: "prose",
      original: "Original text",
      draft: "Fixed draft",
      candidates: {
        "literary-v3.1": { output: "First output" },
        "literary-v3.2.1": { output: "Second output" },
      },
    },
  ],
};

describe("literary blind review", () => {
  it("creates a stable anonymous candidate order", () => {
    const first = buildBlindReviewData(report);
    const second = buildBlindReviewData(report);

    expect(first).toEqual(second);
    expect(Object.values(first.cases[0].candidates).sort()).toEqual([
      "First output",
      "Second output",
    ]);
  });

  it("keeps prompt identities out of the review HTML", () => {
    const html = buildLiteraryReviewHtml(report);

    expect(html).toContain("Candidate A");
    expect(html).toContain("Candidate B");
    expect(html).toContain("First output");
    expect(html).not.toContain("literary-v3.1");
    expect(html).not.toContain("literary-v3.2.1");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("maps exported anonymous choices back to prompt versions", () => {
    const order = candidateOrder(report, "case-1");
    const summary = summarizeLiteraryReview(report, {
      schemaVersion: 1,
      sourceFingerprint: comparisonFingerprint(report),
      reviews: [{ id: "case-1", choice: "A", candidateFlags: { A: [], B: [] }, notes: "" }],
    });

    expect(summary.wins[order[0]]).toBe(1);
    expect(summary.reviewed).toBe(1);
  });

  it("rejects reviews exported from another comparison", () => {
    expect(() =>
      summarizeLiteraryReview(report, {
        schemaVersion: 1,
        sourceFingerprint: "wrong",
        reviews: [],
      }),
    ).toThrow("does not match");
  });

  it("invalidates saved reviews when any reviewed text changes", () => {
    const changed = structuredClone(report);
    changed.results[0].candidates["literary-v3.2.1"].output = "Changed output";

    expect(comparisonFingerprint(changed)).not.toBe(comparisonFingerprint(report));
  });
});
