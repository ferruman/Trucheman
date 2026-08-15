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
    // «до спасения двенадцатого числа» is a translation of "till his rescue on the 12th",
    // not a dropped number; reporting it buried the one date that had really been lost.
    expect(
      scanSegment("till his rescue on the 12th", "до спасения двенадцатого числа", "s1", "ru"),
    ).toEqual([]);
    expect(
      scanSegment("on March 22nd he wrote", "двадцать второго марта он написал", "s1", "ru"),
    ).toEqual([]);
    // Still reported when the number is simply gone, and when the language has no table.
    expect(scanSegment("on March 22nd he wrote", "марта он написал", "s1", "ru")[0]?.kind).toBe(
      "missing_numbers",
    );
    expect(
      scanSegment("till his rescue on the 12th", "до спасения двенадцатого числа", "s1", "pl")[0]
        ?.kind,
    ).toBe("missing_numbers");
  });

  it("accepts calibers, model years and magnitudes the way Russian writes them", () => {
    // A production run reported 26 dropped numbers and every one of them was this: the
    // hundreds-and-tens numerals of a caliber, a two-digit year, or a rounded count.
    const ru = (source: string, translation: string) =>
      scanSegment(source, translation, "s1", "ru").map((defect) => defect.kind);
    expect(ru("he aimed the .357 at her", "он навёл «триста пятьдесят седьмой» на неё")).toEqual(
      [],
    );
    expect(ru("a pair of .45s in his bag", "пара сорок пятых в его сумке")).toEqual([]);
    expect(ru("perched on a ’49 Merc", "сидела на «мерке» сорок девятого года")).toEqual([]);
    expect(ru("perched on a ’49 Merc", "сидела на «мерке» 1949 года")).toEqual([]);
    expect(ru("345,000 miles on the odometer", "345 тысяч миль на одометре")).toEqual([]);
    expect(ru("a swallow of H2O", "глоток H₂O")).toEqual([]);
    // The number is still gone when nothing stands in for it.
    expect(ru("he aimed the .357 at her", "он навёл пистолет на неё")).toEqual(["missing_numbers"]);
  });

  it('does not read the scanned pronoun "1" as a dropped number', () => {
    const ru = (source: string, translation: string) =>
      scanSegment(source, translation, "s1", "ru").map((defect) => defect.kind);
    // OCR turns "I" into "1" — 26 of one run's 27 dropped-number findings were this.
    expect(
      ru("I didn’t see anybody until 1 got here.", "Я никого не видел, пока не пришёл."),
    ).toEqual([]);
    expect(ru("Her name’s Shadow. 1 Embraced her.", "Её зовут Шэдоу. Я обратил её.")).toEqual([]);
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
      ru("its 20,320-foot crown", "её вершина высотой в двадцать тысяч триста двадцать футов"),
    ).toEqual([]);
    expect(ru("1,000 miles away", "в тысяче миль отсюда")).toEqual([]);
    expect(ru("2,500 men", "две тысячи пятьсот человек")).toEqual([]);
    // A thousand short of its own numeral is still a dropped number.
    expect(ru("its 20,320-foot crown", "её вершина высотой в триста двадцать футов")).toEqual([
      "missing_numbers",
    ]);
  });

  it("separates a word left inside a sentence from text the book keeps foreign", () => {
    // Every residue run 9cfcd03a produced, and which side of the line it fell on.
    const interference: Array<[string, string, string]> = [
      [
        "Ms. Therman did an admirable job",
        "Госпожа Терман проделала admirable работу",
        "admirable",
      ],
      ["Charnas sounded shocked.", "Чарнас sounded изумлённым, и все замолчали.", "sounded"],
      [
        "Ilse wished she could slip back",
        "Ильза wished она могла бы соскользнуть обратно",
        "wished",
      ],
      ["he formally bowed to her", "Она встала, и он formally поклонился ей.", "formally"],
    ];
    for (const [source, translation, word] of interference) {
      const defects = scanSegment(source, translation, "s1").filter((defect) =>
        defect.kind.startsWith("source_"),
      );
      expect([word, defects.map((defect) => defect.kind)]).toEqual([word, ["source_interference"]]);
      expect(defects[0].spans).toEqual([word]);
    }

    const preserved: Array<[string, string]> = [
      // A Latin incantation, a German line of dialogue, a band name: all kept on purpose.
      [
        "“Ignis magnificus, veni y illuminatum occulos mios,”",
        "— Ignis magnificus, veni y illuminatum occulos mios, — пробормотал он.",
      ],
      ["“Ach, liebe Gott...,” Westphal whispered.", "— Ach, liebe Gott... — прошептал Вестфаль."],
      ["“Wer hat gesiegt!” he cried out.", "— Wer hat gesiegt! — крикнул он."],
      ["Lyle, mein Liebchen, I must ask you", "Лайл, mein Liebchen, я должен просить вас"],
      ["the worst tribute to the Grateful Dead", "худшая дань уважения Grateful Dead в истории"],
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
    // A capitalized word kept as-is is a name, a brand or a title, and keeping it is right.
    // 32 of a production run's 32 residue findings were these, burying four real ones.
    expect(
      kinds(
        "He wore Levi’s and played Nine Inch Nails.",
        "Он носил Levi’s и слушал Nine Inch Nails.",
      ),
    ).toEqual([]);
    // Nor when the source happens to use the same word lowercase in its own prose: the
    // author's page reported «Science Fiction Reviews» against "received excellent reviews".
    expect(
      kinds(
        "He has received excellent reviews from Science Fiction Reviews.",
        "Он получил отличные отзывы от Science Fiction Reviews.",
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
