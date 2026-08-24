import { describe, expect, it } from "vitest";
import { analyzeEpubConsistency } from "../../src/server/epub/consistency-audit.js";

describe("EPUB consistency audit", () => {
  it("reports all deterministic consistency dimensions", () => {
    const report = analyzeEpubConsistency(
      [
        {
          id: "chapter",
          lang: "en",
          xmlLang: "en",
          text:
            '«Белый Кролик" Алиса встретила Элис, а Алиса снова увидела Элис на Куин-стрит и на улице Куин. ' +
            "Тёмные звёзды. 49° 51´ и 47°9'",
        },
      ],
      "en",
      "ru",
    );

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unbalanced guillemets"),
        expect.stringContaining("straight double quote"),
        expect.stringContaining("street-name conventions"),
        expect.stringContaining("coordinate minute"),
        expect.stringContaining("Package language"),
        expect.stringContaining("XHTML lang/xml:lang"),
      ]),
    );
    expect(report.checks.coordinates.map((coordinate) => coordinate.canonical)).toEqual([
      "49° 51′",
      "47° 9′",
    ]);
    expect(report.checks.yo.windows).toHaveLength(1);
  });

  it("detects a local ё distribution gap inside one XHTML document", () => {
    const report = analyzeEpubConsistency(
      [
        {
          id: "chapter",
          lang: "ru",
          xmlLang: "ru",
          text: `мёртвый чёрный звёзды ${"мертвые темные звезды ".repeat(500)}`,
        },
      ],
      "ru",
      "ru",
    );

    expect(report.warnings).toContain(
      "Possible ё drift: a 4000-character Russian window contains no ё",
    );
  });

  it("flags duplicated fragments, empty documents, and corrupted TOC labels", () => {
    const report = analyzeEpubConsistency(
      [
        {
          id: "chapter",
          lang: "ru",
          xmlLang: "ru",
          text: "У Белого Кролика кролик. Он не нашёл золотого ключа ключ.",
        },
        { id: "blank", lang: "ru", xmlLang: "ru", text: "   " },
      ],
      "ru",
      "ru",
      [
        "Глава III Бег Кролика Эпилог Кролик",
        "ГЛАВА I. Вниз по кроличьей норе",
        // The same word twice is how a chapter names its setting and then its title.
        "Пятница, 4 мая, сад — Глава: сад",
        "Эпилог Эпилог",
      ],
    );

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        'chapter: duplicated fragment "кролика кролик"',
        'chapter: duplicated fragment "ключа ключ"',
        "blank: translated document is empty",
        'Table of contents entry is corrupted: "Глава III Бег Кролика Эпилог Кролик"',
      ]),
    );
    expect(report.checks.tableOfContents[1]).toEqual({
      label: "ГЛАВА I. Вниз по кроличьей норе",
      duplicates: [],
    });
    expect(report.checks.tableOfContents[2]).toEqual({
      label: "Пятница, 4 мая, сад — Глава: сад",
      duplicates: [],
    });
    expect(report.warnings).toContain('Table of contents entry is corrupted: "Эпилог Эпилог"');
  });

  it("does not treat a heading and the following block as one duplicated fragment", () => {
    const report = analyzeEpubConsistency(
      [
        {
          id: "copyright",
          lang: "ru",
          xmlLang: "ru",
          text: "ИСТОРИЯ ИЗДАНИЙ\nТестовое издание / январь 2099",
        },
      ],
      "ru",
      "ru",
    );

    expect(report.checks.duplicatedFragments).toEqual([]);
  });

  it("keeps a real duplicated name without reporting ordinary Russian word pairs", () => {
    const report = analyzeEpubConsistency(
      [
        {
          id: "chapter",
          lang: "ru",
          xmlLang: "ru",
          text: [
            // Corruption: the ship name was written twice.
            "Я видел «Алерт», «Алерт» теперь проданный.",
            // Ordinary prose that a shared four-letter prefix used to flag.
            "В конце концов он решил провести проверку.",
            "Голова головоногого была наклонена вперёд.",
            // Corruption: a fragmented span rejoined, the two endings disagreeing.
            "Лежал в земле земля была холодной.",
            // Deliberate repetition, marked as such by its punctuation.
            "Сохранились остатки … остатки древней эпохи.",
            "Бой тамтамов слышался далеко-далеко впереди.",
            // Emphasis, which is how Russian intensifies — 53 of one run's 56 findings.
            "Было очень очень тихо, и он сказал: «Давай, давай!»",
            "Она молчала, молчала, а потом закричала.",
            // Two sentences that happen to name the same person on both sides of a stop.
            "Алиса не думала про обиды Дины. Дина знала лучше.",
            // The same across a stop with the endings disagreeing: a figure of speech, a
            // name declined into the next sentence, and a paragraph meeting the next one.
            "Ничто из этого не имело значения. Значение имел золотой ключ.",
            "Чай разлился узором возле Алисы. Алиса молча вытерла стол.",
            "Он вернулся взглядом к дороге. Дорога обратно заняла недолго.",
          ].join(" "),
        },
      ],
      "ru",
      "ru",
      [],
    );
    const duplicates = report.warnings.filter((warning) => warning.includes("duplicated fragment"));

    expect(duplicates).toEqual(['chapter: duplicated fragment "земле земля"']);
  });
});
