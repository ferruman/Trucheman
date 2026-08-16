import { describe, expect, it } from "vitest";
import {
  flattenRuby,
  horizontalizeContent,
  horizontalizePackage,
} from "../../src/server/epub/japanese.js";
import { parseXml, serializeXml } from "../../src/server/epub/xml-dom.js";
import { extractTextSegments } from "../../src/server/epub/text-segments.js";
import {
  batchCharBudget,
  batchSegmentCap,
  makeBatches,
  MAX_BATCH_SEGMENTS,
} from "../../src/server/epub/batcher.js";
import { scanSegment } from "../../src/server/jobs/segment-scan.js";
import { extractRepeatedSourceEntities } from "../../src/server/jobs/consistency-service.js";
import { sourceLanguageRules } from "../../src/server/config/source-language.js";
import type { TextSegment } from "../../src/server/epub/text-segments.js";
import type { ConsistencyDocument } from "../../src/server/jobs/consistency-service.js";

const xhtml = (body: string, htmlClass = "vrtl") =>
  parseXml(
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" class="${htmlClass}"><body>${body}</body></html>`,
  );

const unit = (id: string, text: string): TextSegment =>
  ({ id, text, locator: [0], hash: id, format: "p" }) as unknown as TextSegment;

describe("ruby", () => {
  it("keeps the base, drops the reading, and remembers the pair", () => {
    const doc = xhtml("<p><ruby><span>加藤保憲</span><rt>かとうやすのり</rt></ruby>は立った。</p>");
    const readings = new Map<string, string>();

    expect(flattenRuby(doc, readings)).toBe(1);

    const out = serializeXml(doc);
    expect(out).toContain("加藤保憲");
    expect(out).not.toContain("かとうやすのり");
    expect(out).not.toContain("<ruby>");
    // the wrapper the reader ships its text in survives; only the gloss is gone
    expect(out).toContain("<span>加藤保憲</span>");
    expect(readings.get("加藤保憲")).toBe("かとうやすのり");
  });

  it("drops rp fallbacks and glosses that annotate no kanji", () => {
    const doc = xhtml("<p><ruby>ドア<rp>(</rp><rt>door</rt><rp>)</rp></ruby></p>");
    const readings = new Map<string, string>();
    flattenRuby(doc, readings);
    const out = serializeXml(doc);
    expect(out).toContain("ドア");
    expect(out).not.toContain("door");
    expect(out).not.toContain("(");
    // a katakana base needs no reading, so none is recorded to mislead the registry
    expect(readings.size).toBe(0);
  });

  it("segments the same in memory as it does after a round trip through the file", () => {
    // Lifting the base out of the ruby left "その夜、", "加藤" and "は立った。" as three sibling
    // text nodes, which a parser reading the file back merges into one. Assembly re-reads the
    // document it prepared, so the whole volume failed with "Source changed" at reinsertion —
    // and every glossed word had been a segment of its own, translated out of its sentence.
    const doc = xhtml("<p>その夜、<ruby>加藤<rt>かとう</rt></ruby>は立った。</p>");
    flattenRuby(doc);

    const inMemory = extractTextSegments(doc, "document-1").map((segment) => segment.text);
    const reparsed = extractTextSegments(parseXml(serializeXml(doc)), "document-1").map(
      (segment) => segment.text,
    );

    expect(inMemory).toEqual(reparsed);
    expect(inMemory).toEqual(["その夜、加藤は立った。"]);
  });

  it("reads nested ruby innermost first", () => {
    const doc = xhtml(
      "<p><ruby><ruby>帝都<rt>ていと</rt></ruby>物語<rt>ものがたり</rt></ruby></p>",
    );
    const readings = new Map<string, string>();
    flattenRuby(doc, readings);
    expect(serializeXml(doc)).toContain("帝都物語");
    expect(readings.get("帝都")).toBe("ていと");
  });
});

describe("writing direction", () => {
  it("turns the content documents horizontal", () => {
    const doc = xhtml("<p>本文</p>");
    expect(horizontalizeContent(doc)).toBe(1);
    expect(serializeXml(doc)).toContain('class="hltr"');
    // already horizontal pages are left alone
    expect(horizontalizeContent(xhtml("<p>本文</p>", "hltr"))).toBe(0);
  });

  it("turns the spine forwards", () => {
    const opf = parseXml(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><spine page-progression-direction="rtl" toc="ncx"/></package>`,
    );
    expect(horizontalizePackage(opf)).toBe(true);
    expect(serializeXml(opf)).toContain('page-progression-direction="ltr"');
    expect(horizontalizePackage(opf)).toBe(false);
  });
});

describe("batching Japanese", () => {
  it("budgets fewer characters than for a Latin source", () => {
    expect(batchCharBudget("ja")).toBeLessThan(batchCharBudget("en"));
    expect(batchCharBudget(undefined)).toBe(batchCharBudget("en"));
  });

  it("caps a Japanese batch by segments, which is the limit that actually binds", () => {
    expect(batchSegmentCap("ja")).toBeLessThan(batchSegmentCap("en"));
    expect(batchSegmentCap(undefined)).toBe(MAX_BATCH_SEGMENTS);

    // Japanese paragraphs are short, so the character budget never comes near: twenty of them
    // fit in under a thousand characters, and twenty fragments in one answer is what the model
    // lost count of.
    const paragraphs = Array.from({ length: 40 }, (_, index) =>
      unit(`document-1:${index + 1}`, "帝都は燃えていた。".repeat(5)),
    );
    const batches = makeBatches(paragraphs, batchCharBudget("ja"), batchSegmentCap("ja"));
    expect(batches).toHaveLength(4);
    for (const batch of batches) expect(batch.segments).toHaveLength(10);
  });

  it("splits an oversized node on 。 and joins the pieces without spaces", () => {
    const sentence = `${"帝都は燃えていた".repeat(20)}。`;
    const batches = makeBatches([unit("document-1:1", sentence.repeat(12))], 400);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.segments[0].text.length).toBeLessThanOrEqual(400);
    // no space is invented at a seam that the original wrote as one run
    expect(batches.map((batch) => batch.segments[0].text).join("")).not.toContain(" ");
  });

  it("keeps a closing 」 with the sentence it ends", () => {
    const text = `「行くぞ。」と加藤は言った。${"帝都は燃えていた。".repeat(40)}`;
    const chunks = makeBatches([unit("document-1:1", text)], 120).map(
      (batch) => batch.segments[0].text,
    );
    expect(chunks.some((chunk) => chunk.startsWith("」"))).toBe(false);
  });
});

describe("scanning a Japanese source", () => {
  const kinds = (source: string, translation: string) =>
    scanSegment(source, translation, "s1").map((defect) => defect.kind);

  it("does not report a faithful translation as over-long", () => {
    // Japanese says in one character about what three Latin ones do
    const source = "帝都は燃えていた。".repeat(12);
    expect(kinds(source, "Столица горела. ".repeat(36))).toEqual([]);
    // the same tolerance still catches a block that was lost
    expect(kinds(source, "Столица горела.")).toEqual(["length_ratio"]);
    expect(kinds(source, "Столица горела. ".repeat(200))).toEqual(["length_ratio"]);
  });

  it("reports a block the model never translated, even once editing has retouched it", () => {
    // Seven consecutive paragraphs of a finished book were still Japanese. Identity missed
    // them because the editing pass had normalized the spacing of the untouched source, and
    // residue missed them because it only looks inside a Cyrillic translation.
    const source =
      "　市ケ谷の小高い丘に早ばやと 闇 が訪れた。一月の夕暮れは早い。四時を回るや否や。";
    const retouched = source.replace(/ /g, "");
    expect(retouched).not.toBe(source);
    expect(kinds(source, retouched)).toEqual(["untranslated"]);

    // Thirty-one Japanese characters is a whole sentence, not a heading the floor should spare.
    const short = "　枯れ草が急にさわさわと揺らぎ、そのあいだに黒い影が現われた。";
    expect(short.length).toBeLessThan(40);
    expect(kinds(short, short)).toEqual(["untranslated"]);

    // A real translation of the same block is not flagged.
    expect(
      kinds(source, "На холм Итигая рано опустилась тьма. Январские сумерки коротки."),
    ).toEqual([]);
  });

  it("reports kana and kanji left standing in Russian prose", () => {
    const source = "加藤は帝都の空を見上げた。".repeat(8);
    const left = `Като посмотрел на небо 帝都 над городом. ${"Он долго молчал и не двигался. ".repeat(6)}`;
    expect(kinds(source, left)).toContain("source_interference");
  });
});

describe("entities in a Japanese source", () => {
  const documents = (texts: string[]): ConsistencyDocument[] => [
    {
      id: "document-1",
      sourceSegments: texts.map((text, index) => unit(`document-1:${index + 1}`, text)),
      editedSegments: [],
    },
  ];

  it("finds a name the book marks with an honorific", () => {
    const found = extractRepeatedSourceEntities(
      documents([
        "その夜、加藤さんは黙っていた。",
        "だれもが加藤さんを恐れていた。",
        "辰宮さんが加藤さんに尋ねた。",
      ]),
    );
    const sources = found.map((entity) => entity.source);
    expect(sources).toContain("加藤");
    expect(sources).toContain("辰宮");
  });

  it("finds a place by its suffix and drops the common compounds", () => {
    const found = extractRepeatedSourceEntities(
      documents([
        "自分は平将門神社に行った。時間がなかった。",
        "自分は平将門神社を出た。時間だけが過ぎた。",
      ]),
    );
    const sources = found.map((entity) => entity.source);
    expect(sources).toContain("平将門神社");
    expect(sources).not.toContain("自分");
    expect(sources).not.toContain("時間");
  });

  it("carries the book's own furigana to the registry", () => {
    const found = extractRepeatedSourceEntities(
      documents(["加藤さんが来た。", "加藤さんは去った。", "だれもが加藤さんを見た。"]),
      { 加藤: "かとう" },
    );
    expect(found.find((entity) => entity.source === "加藤")?.reading).toBe("かとう");
  });
});

describe("source-language rules", () => {
  it("adds Polivanov for Japanese into Russian and nothing for English", () => {
    expect(sourceLanguageRules("ja", "ru")).toContain("Polivanov");
    expect(sourceLanguageRules("ja", "de")).not.toContain("Polivanov");
    expect(sourceLanguageRules("ja", "de")).toContain("family name first");
    expect(sourceLanguageRules("en", "ru")).toBe("");
    expect(sourceLanguageRules(undefined)).toBe("");
  });
});
