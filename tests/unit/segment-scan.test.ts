import { describe, expect, it } from "vitest";
import { scanSegment, scanSegments } from "../../src/server/jobs/segment-scan.js";

const kinds = (source: string, translation: string) =>
  scanSegment(source, translation, "s1").map((defect) => defect.kind);

describe("scanSegment", () => {
  it("reports an empty translation of non-empty source", () => {
    expect(kinds("The room was cold.", "   ")).toEqual(["empty"]);
    expect(kinds("  ", "")).toEqual([]);
  });

  it("reports a translation left in the source language, once", () => {
    const source = "The room was cold, and the window had been open since morning.";
    expect(kinds(source, source)).toEqual(["untranslated"]);
    // short blocks are legitimately identical: names, numbers, headings
    expect(kinds("Chapter 4", "Chapter 4")).toEqual([]);
  });

  it("reports a translation far shorter or longer than the original", () => {
    const source = "x".repeat(200);
    expect(kinds(source, "у".repeat(80))).toEqual(["length_ratio"]);
    expect(kinds(source, "у".repeat(500))).toEqual(["length_ratio"]);
    expect(kinds(source, "у".repeat(240))).toEqual([]);
    // below the floor, a ratio means nothing
    expect(kinds("Cold.", "Очень, очень холодно, почти невыносимо.")).toEqual([]);
  });

  it("reports numbers dropped from the translation", () => {
    const defects = scanSegment("He waited 12 years and 3 days.", "Он ждал 12 лет.", "s1");
    expect(defects).toHaveLength(1);
    expect(defects[0].kind).toBe("missing_numbers");
    expect(defects[0].detail).toContain("3");
    expect(kinds("He waited 12 years.", "Он ждал 12 лет.")).toEqual([]);
  });

  it("reports source words carried into a different script, and not names in the same script", () => {
    const defects = scanSegment(
      "The harbour was quiet that evening.",
      "В harbour было тихо в тот вечер.",
      "s1",
    );
    expect(defects.map((defect) => defect.kind)).toEqual(["source_residue"]);
    expect(defects[0].detail).toContain("harbour");
    // Latin to Latin: a shared word is a name or a cognate, not residue
    expect(kinds("The harbour was quiet.", "Der harbour war ruhig.")).toEqual([]);
  });
});

describe("scanSegments", () => {
  it("pairs by id and treats a missing translation as empty", () => {
    const defects = scanSegments(
      [
        { id: "a", text: "The room was cold." },
        { id: "b", text: "Он ждал." },
      ],
      [{ id: "b", text: "Он ждал." }],
    );
    expect(defects).toEqual([{ id: "a", kind: "empty", detail: "translation is empty" }]);
  });
});
