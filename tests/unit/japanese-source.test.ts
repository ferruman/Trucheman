import { describe, expect, it } from "vitest";
import {
  flattenRuby,
  horizontalizeContent,
  horizontalizePackage,
  latinizeFontStack,
  latinizeStylesheet,
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
    const doc = xhtml("<p><ruby><span>山嵐</span><rt>やまあらし</rt></ruby>は立った。</p>");
    const readings = new Map<string, string>();

    expect(flattenRuby(doc, readings)).toBe(1);

    const out = serializeXml(doc);
    expect(out).toContain("山嵐");
    expect(out).not.toContain("やまあらし");
    expect(out).not.toContain("<ruby>");
    // the wrapper the reader ships its text in survives; only the gloss is gone
    expect(out).toContain("<span>山嵐</span>");
    expect(readings.get("山嵐")).toBe("やまあらし");
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
    // Lifting the base out of the ruby leaves surrounding text as separate sibling
    // text nodes, which a parser reading the file back merges into one. Assembly re-reads the
    // document it prepared, so the whole volume failed with "Source changed" at reinsertion —
    // and every glossed word had been a segment of its own, translated out of its sentence.
    const doc = xhtml("<p>おれは<ruby>清<rt>きよ</rt></ruby>の事を考えている。</p>");
    flattenRuby(doc);

    const inMemory = extractTextSegments(doc, "document-1").map((segment) => segment.text);
    const reparsed = extractTextSegments(parseXml(serializeXml(doc)), "document-1").map(
      (segment) => segment.text,
    );

    expect(inMemory).toEqual(reparsed);
    expect(inMemory).toEqual(["おれは清の事を考えている。"]);
  });

  it("reads nested ruby innermost first", () => {
    const doc = xhtml(
      "<p><ruby><ruby>坊<rt>ぼう</rt></ruby>っちゃん<rt>ぼっちゃん</rt></ruby></p>",
    );
    const readings = new Map<string, string>();
    flattenRuby(doc, readings);
    expect(serializeXml(doc)).toContain("坊っちゃん");
    expect(readings.get("坊")).toBe("ぼう");
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

  it("loads the horizontal stylesheet instead of the vertical one", () => {
    // The class was only half the switch. These books ship one stylesheet per direction and
    // choose with `rel`: the vertical sheet is preferred, the horizontal one is `alternate`,
    // which a reader does not apply. Both halves of the switch have to move together.
    const doc = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml" class="vrtl"><head>` +
        `<link rel="stylesheet" href="book-style.css"/>` +
        `<link class="vertical" rel="stylesheet" href="v.css" title="縦組"/>` +
        `<link class="horizontal" rel="alternate stylesheet" href="h.css" title="横組"/>` +
        `</head><body><p>本文</p></body></html>`,
    );

    expect(horizontalizeContent(doc)).toBe(3);

    const out = serializeXml(doc);
    expect(out).toMatch(/class="vertical" rel="alternate stylesheet"/);
    expect(out).toMatch(/class="horizontal" rel="stylesheet"/);
    // The page's ordinary stylesheet is not one of the pair and stays as it is.
    expect(out).toContain('<link rel="stylesheet" href="book-style.css"/>');
    expect(out).toContain('class="hltr"');
  });

  it("recognises the pair by its Japanese titles when the classes are absent", () => {
    const doc = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head>` +
        `<link rel="stylesheet" href="v.css" title="縦組"/>` +
        `<link rel="alternate stylesheet" href="h.css" title="横組"/>` +
        `</head><body/></html>`,
    );
    expect(horizontalizeContent(doc)).toBe(2);
    expect(serializeXml(doc)).toMatch(/rel="stylesheet" href="h\.css"/);
  });

  it("takes the book's Cyrillic out of a Japanese face", () => {
    // Cyrillic exists in Mincho and Gothic but is drawn full-width, one letter per CJK em box,
    // so a translated volume read with enormous gaps between its letters. Nothing is embedded:
    // the families name system fonts and the aliases resolve to local("ＭＳ 明朝").
    expect(
      latinizeFontStack(
        '"Hiragino Mincho ProN","ヒラギノ明朝 Pro W3","MS Mincho","ＭＳ 明朝",serif',
      ),
    ).toBe("serif");
    // A vertical-writing stack (the @ prefix) reaching for a sans face lands on sans-serif.
    expect(
      latinizeFontStack('"@HiraKakuProN-W3","@ヒラギノ角ゴ Pro W3","MS Gothic",sans-serif'),
    ).toBe("sans-serif");
    expect(latinizeFontStack("serif-ja, serif")).toBe("serif");
    // A stack with nothing Japanese in it is the book's own choice and is left alone.
    expect(latinizeFontStack('Georgia, "Times New Roman", serif')).toBe(
      'Georgia, "Times New Roman", serif',
    );

    const sheet = latinizeStylesheet(
      `body { font-family: "MS Mincho",serif; }\n.g { font-family: "MS Gothic",sans-serif !important; }`,
    );
    expect(sheet.changes).toBe(2);
    expect(sheet.value).toContain("font-family: serif;");
    expect(sheet.value).toContain("font-family: sans-serif !important;");
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
      unit(`document-1:${index + 1}`, "船は静かな海を岸へ漕ぎ戻る。".repeat(5)),
    );
    const batches = makeBatches(paragraphs, batchCharBudget("ja"), batchSegmentCap("ja"));
    expect(batches).toHaveLength(4);
    for (const batch of batches) expect(batch.segments).toHaveLength(10);
  });

  it("splits an oversized node on 。 and joins the pieces without spaces", () => {
    const sentence = `${"船は静かな海を岸へ漕ぎ戻る".repeat(20)}。`;
    const batches = makeBatches([unit("document-1:1", sentence.repeat(12))], 400);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.segments[0].text.length).toBeLessThanOrEqual(400);
    // no space is invented at a seam that the original wrote as one run
    expect(batches.map((batch) => batch.segments[0].text).join("")).not.toContain(" ");
  });

  it("keeps a closing 」 with the sentence it ends", () => {
    const text = `「おい君は宿直じゃないか」と山嵐は聞いた。${"船は静かな海を岸へ漕ぎ戻る。".repeat(40)}`;
    const chunks = makeBatches([unit("document-1:1", text)], 120).map(
      (batch) => batch.segments[0].text,
    );
    expect(chunks.some((chunk) => chunk.startsWith("」"))).toBe(false);
  });
});

describe("scanning a Japanese source", () => {
  const kinds = (source: string, translation: string) =>
    scanSegment(source, translation, "s1", "ru").map((defect) => defect.kind);

  it("does not report a faithful translation as over-long", () => {
    // Japanese says in one character about what three Latin ones do
    const source = "船は静かな海を岸へ漕ぎ戻る。".repeat(12);
    expect(kinds(source, "Лодка тихо возвращалась к берегу. ".repeat(24))).toEqual([]);
    // the same tolerance still catches a block that was lost
    expect(kinds(source, "Лодка вернулась.")).toEqual(["length_ratio"]);
    expect(kinds(source, "Лодка тихо возвращалась к берегу. ".repeat(200))).toEqual([
      "length_ratio",
    ]);
  });

  it("reports a block the model never translated, even once editing has retouched it", () => {
    // Public-domain Botchan text whose spacing was normalized by an editing pass.
    const source =
      "　教師も生徒も帰ってしまったあとで、一人 ぽかん としているのは随分間が抜けたものだ。";
    const retouched = source.replace(/ /g, "");
    expect(retouched).not.toBe(source);
    expect(kinds(source, retouched)).toEqual(["untranslated"]);

    // Thirty-one Japanese characters is a whole sentence, not a heading the floor should spare.
    const short = "　おれは空を見ながら清の事を考えている。";
    expect(short.length).toBeLessThan(40);
    expect(kinds(short, short)).toEqual(["untranslated"]);

    // Our repository-owned translation of the same public-domain block is not flagged.
    expect(
      kinds(source, "Когда учителя и ученики разошлись, сидеть одному без дела было нелепо."),
    ).toEqual([]);
  });

  it("separates a kanji run from the Russian word it fuses with", () => {
    // Japanese writes no space, so a leaked kanji run fuses with its Cyrillic neighbour.
    const source = "学校には宿直があって、職員が代る代るこれをつとめる。".repeat(3);
    const leaked =
      "Ведь宿直 в школе дежурили учителя, сменяя друг друга. " +
      "Каждый исполнял эту обязанность по очереди.";
    const defects = scanSegment(source, leaked, "s1", "ru");
    expect(defects.map((d) => d.kind)).toContain("source_interference");
    expect(defects.find((d) => d.kind === "source_interference")?.spans).toEqual(["宿直"]);
  });

  it("leaves a glossed original alone, in brackets as well as in quotes", () => {
    // The translation spells out a public-domain character name and keeps its source form.
    const gloss = scanSegment(
      "山嵐は強者の権利について説明した。".repeat(3),
      "Ямаараси (山嵐) объяснил, что означает право сильного, и продолжил спор.",
      "s1",
      "ru",
    );
    expect(gloss.map((d) => d.kind)).not.toContain("source_interference");

    const quoted = scanSegment(
      "生徒がおれの事を赤手拭と云うんだそうだ。".repeat(4),
      "Оказалось, что ученики прозвали героя «赤手拭» — «красное полотенце».",
      "s1",
      "ru",
    );
    expect(quoted.map((d) => d.kind)).not.toContain("source_interference");
  });

  it("reports kana and kanji left standing in Russian prose", () => {
    const source = "おれは空を見ながら清の事を考えている。".repeat(8);
    const left = `Герой смотрел на небо и думал о 清 весь вечер. ${"Он долго молчал. ".repeat(6)}`;
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
        "おれは山嵐さんの事を考えている。",
        "山嵐さんを連れて来たら愉快だろう。",
        "赤シャツさんが山嵐さんについて尋ねた。",
      ]),
    );
    const sources = found.map((entity) => entity.source);
    expect(sources).toContain("赤シャツ");
    expect(sources).toContain("山嵐");
  });

  it("finds a place by its suffix and drops the common compounds", () => {
    const found = extractRepeatedSourceEntities(
      documents([
        "自分は住田町に行った。時間がなかった。",
        "自分は住田町を出た。時間だけが過ぎた。",
      ]),
    );
    const sources = found.map((entity) => entity.source);
    expect(sources).toContain("住田町");
    expect(sources).not.toContain("自分");
    expect(sources).not.toContain("時間");
  });

  it("carries the book's own furigana to the registry", () => {
    const found = extractRepeatedSourceEntities(
      documents(["山嵐さんが来た。", "山嵐さんは去った。", "だれもが山嵐さんを見た。"]),
      { 山嵐: "やまあらし" },
    );
    expect(found.find((entity) => entity.source === "山嵐")?.reading).toBe("やまあらし");
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
