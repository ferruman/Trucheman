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
            '«Ктулху" Энджелл встретил Анджелла, а Энджелл снова увидел Анджелла на Томас-стрит и на улице Томаса. ' +
            "Мертвые звезды. 49° 51´ и 47°9'",
        },
      ],
      "en",
      "ru",
    );

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unbalanced guillemets"),
        expect.stringContaining("straight double quote"),
        expect.stringContaining("capitalized-name cluster"),
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
});
