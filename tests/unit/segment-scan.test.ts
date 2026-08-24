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
    // a page-number list is identical in every language and holds no word to translate
    const pages = "i 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20";
    expect(kinds(pages, pages)).toEqual([]);
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

  it("treats a grouped number and its ungrouped form as the same number", () => {
    // The real finding: "$1 to $5,000" against «от $1 до $5000» compared ["1","5","000"]
    // with ["1","5000"] and called a correct amount dropped.
    expect(kinds("donations of $1 to $5,000 matter", "пожертвования от $1 до $5000 важны")).toEqual(
      [],
    );
    expect(kinds("a fee of 1,250 dollars", "плата в 1 250 долларов")).toEqual([]);
    // Decimals keep their separator meaning, and a genuinely dropped amount still reports.
    expect(kinds("it measured 3.14 metres", "он составил 3,14 метра")[0]).toBeUndefined();
    expect(scanSegment("a fee of 1,250 dollars", "плата в долларах", "s1")[0]?.kind).toBe(
      "missing_numbers",
    );
  });

  it("accepts a Russian number written out in words instead of digits", () => {
    // An ordinal written as a Russian word is not a dropped number.
    expect(
      scanSegment("Alice returned on the 12th", "Алиса вернулась двенадцатого числа", "s1", "ru"),
    ).toEqual([]);
    expect(
      scanSegment("on March 22nd he wrote", "двадцать второго марта он написал", "s1", "ru"),
    ).toEqual([]);
    // Still reported when the number is simply gone, and when the language has no table.
    expect(scanSegment("on March 22nd he wrote", "марта он написал", "s1", "ru")[0]?.kind).toBe(
      "missing_numbers",
    );
    expect(
      scanSegment("Alice returned on the 12th", "Алиса вернулась двенадцатого числа", "s1", "pl")[0]
        ?.kind,
    ).toBe("missing_numbers");
  });

  it("accepts decimals, short labels and magnitudes written as Russian words", () => {
    const ru = (source: string, translation: string) =>
      scanSegment(source, translation, "s1", "ru").map((defect) => defect.kind);
    expect(
      ru("the bottle was marked .357", "на бутылочке стояло «триста пятьдесят седьмой»"),
    ).toEqual([]);
    expect(ru("two cakes marked .45", "два пирожка с номером сорок пять")).toEqual([]);
    expect(ru("a card marked ’49", "карта с номером сорок девять")).toEqual([]);
    expect(ru("a card marked ’49", "карта с номером 1949")).toEqual([]);
    expect(
      ru("345,000 miles down the rabbit-hole", "345 тысяч миль вниз по кроличьей норе"),
    ).toEqual([]);
    expect(ru("a swallow of H2O", "глоток H₂O")).toEqual([]);
    // The number is still gone when nothing stands in for it.
    expect(ru("the bottle was marked .357", "на бутылочке была метка")).toEqual([
      "missing_numbers",
    ]);
  });

  it('does not read the scanned pronoun "1" as a dropped number', () => {
    const ru = (source: string, translation: string) =>
      scanSegment(source, translation, "s1", "ru").map((defect) => defect.kind);
    // OCR can turn "I" into "1" inside otherwise ordinary prose.
    expect(
      ru(
        "I followed the Rabbit until 1 reached the hall.",
        "Я шла за Кроликом, пока не добралась до зала.",
      ),
    ).toEqual([]);
    expect(ru("Her name is Dinah. 1 remembered her.", "Её зовут Дина. Я вспомнила о ней.")).toEqual(
      [],
    );
    // A digit against a digit is still checked, and a Cyrillic source is left alone.
    expect(ru("He waited 1,000 years and 12 days.", "Он ждал тысячу лет.")).toEqual([
      "missing_numbers",
    ]);
    expect(scanSegment("Он ждал 1 год и 12 дней.", "He waited 12 days.", "s1", "en")[0]?.kind).toBe(
      "missing_numbers",
    );
  });

  it("accepts a spelled-out number above a thousand", () => {
    const ru = (source: string, translation: string) =>
      scanSegment(source, translation, "s1", "ru").map((defect) => defect.kind);
    expect(
      ru("that would be four thousand miles down", "это было бы на глубине четырёх тысяч миль"),
    ).toEqual([]);
    expect(ru("1,000 miles away", "в тысяче миль отсюда")).toEqual([]);
    expect(ru("2,500 men", "две тысячи пятьсот человек")).toEqual([]);
    // A thousand short of its own numeral is still a dropped number.
    expect(ru("that would be 4,000 miles down", "это было бы на глубине четырёх миль")).toEqual([
      "missing_numbers",
    ]);
  });

  it("separates a word left inside a sentence from text the book keeps foreign", () => {
    // Every residue run 9cfcd03a produced, and which side of the line it fell on.
    const interference: Array<[string, string, string]> = [
      ["Alice did an admirable job", "Алиса выполнила admirable работу", "admirable"],
      ["Rabbit sounded shocked.", "Кролик sounded потрясённым, и все замолчали.", "sounded"],
      ["Alice wished she could slip back", "Алиса wished снова проскользнуть в дверь", "wished"],
      ["he formally bowed to Alice", "Он formally поклонился Алисе.", "formally"],
    ];
    for (const [source, translation, word] of interference) {
      const defects = scanSegment(source, translation, "s1").filter((defect) =>
        defect.kind.startsWith("source_"),
      );
      expect([word, defects.map((defect) => defect.kind)]).toEqual([word, ["source_interference"]]);
      expect(defects[0].spans).toEqual([word]);
    }

    const preserved: Array<[string, string]> = [
      // Foreign phrases and public-domain character names kept on purpose.
      ["The lesson began with “Où est ma chatte?”", "Урок начался с фразы «Où est ma chatte?»"],
      ["Alice called to the White Rabbit.", "Алиса позвала White Rabbit."],
      ["The Cheshire Cat grinned.", "Cheshire Cat улыбнулся."],
      ["Dinah, ma chère, come here", "Дина, ma chère, иди сюда"],
      ["the strangest tale of the Mock Turtle", "страннейший рассказ Mock Turtle"],
      [
        "they danced under paper bienvenidos banners",
        "они танцевали под бумажными транспарантами «bienvenidos» под музыку",
      ],
    ];
    for (const [source, translation] of preserved) {
      const kinds = scanSegment(source, translation, "s1")
        .map((defect) => defect.kind)
        .filter((kind) => kind === "source_interference");
      expect([translation.slice(0, 24), kinds]).toEqual([translation.slice(0, 24), []]);
    }
  });

  it("reports source words carried into a different script, and not names in the same script", () => {
    const defects = scanSegment(
      "The harbour was quiet that evening.",
      "В harbour было тихо в тот вечер.",
      "s1",
    );
    // Target-language words on both sides: the sentence was translated around it.
    expect(defects.map((defect) => defect.kind)).toEqual(["source_interference"]);
    expect(defects[0].detail).toContain("harbour");
    expect(defects[0].spans).toEqual(["harbour"]);
    expect(
      scanSegment(
        "Ashe Corven was crouching on a narrow cornice.",
        "Эш Корвен crouched на узком карнизе.",
        "s2",
      ),
    ).toEqual([
      {
        id: "s2",
        kind: "source_interference",
        detail: "source words left inside the translation: crouched",
        spans: ["crouched"],
      },
    ]);
    // Latin to Latin: a shared word is a name or a cognate, not residue
    expect(kinds("The harbour was quiet.", "Der harbour war ruhig.")).toEqual([]);
    // Capitalized public-domain character names may intentionally remain untranslated.
    expect(
      kinds(
        "Alice followed the White Rabbit and met the Cheshire Cat.",
        "Алиса последовала за White Rabbit и встретила Cheshire Cat.",
      ),
    ).toEqual([]);
    // Nor when the source also uses the same word lowercase as an ordinary noun.
    expect(
      kinds(
        "The Mouse told Alice about a mouse, then met the Mock Turtle.",
        "Мышь рассказала Алисе о мыши, затем встретила Mock Turtle.",
      ),
    ).toEqual([]);
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
