import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyConsistencyDecisions,
  buildConsistencyReport,
  extractRepeatedSourceEntities,
  mergeGlossaries,
  resolveEntityRegistry,
  type ConsistencyDocument,
} from "../../src/server/jobs/consistency-service.js";
import type { LanguageModelProvider } from "../../src/server/providers/provider.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sourceSegment(id: string, text: string) {
  return { id, text, sourceHash: "hash", locator: [], leading: "", trailing: "" };
}

function documents(): ConsistencyDocument[] {
  return [
    {
      id: "chapter",
      sourceSegments: [
        sourceSegment("chapter:0", "Professor Angell boarded the Vigilant."),
        sourceSegment("chapter:1", "Angell later described the Vigilant."),
      ],
      editedSegments: [
        { id: "chapter:0", text: "Профессор Анджелл поднялся на «Бдительный»." },
        {
          id: "chapter:1",
          text: "Позже Энджелл описал «Виджилент» и \" Р'льех »: мёртвый мертвый.",
        },
      ],
    },
  ];
}

describe("book-wide consistency", () => {
  it("extracts repeated source entities with aligned target evidence", () => {
    const entities = extractRepeatedSourceEntities(documents());

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "Angell", occurrences: 2 }),
        expect.objectContaining({ source: "Vigilant", occurrences: 2 }),
      ]),
    );
    expect(entities.find((entry) => entry.source === "Angell")?.contexts[0]?.target).toContain(
      "Анджелл",
    );
  });

  it("reports quote and yo inconsistencies without rewriting prose", () => {
    const report = buildConsistencyReport(documents());

    expect(report.documents[0].quotes.balanced).toBe(false);
    expect(report.documents[0].yo.variants).toContainEqual({
      key: "мертвый",
      variants: ["мертвый", "мёртвый"],
    });
    expect(report.warningCount).toBeGreaterThan(0);
  });

  it("flags a long document region that unexpectedly stops using ё", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "drift",
        sourceSegments: [],
        editedSegments: [
          { id: "drift:0", text: "мёртвый, чёрный, звёзды" },
          { id: "drift:1", text: "мертвые темные звезды ".repeat(220) },
        ],
      },
    ];

    expect(buildConsistencyReport(values).documents[0].yo.possibleDrift).toBe(true);
  });

  it("applies only variants supported by source-aligned evidence", () => {
    const values = documents();
    const applied = applyConsistencyDecisions(values, [
      { source: "Angell", canonical: "Энджелл", variants: ["Анджелл"] },
      { source: "NotPresent", canonical: "Канон", variants: ["Профессор"] },
    ]);

    expect(applied).toBe(1);
    expect(values[0].editedSegments[0].text).toContain("Профессор Энджелл");
    expect(values[0].editedSegments[0].text).not.toContain("Канон");
  });

  it("builds and caches a validated model-generated entity registry", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-`);
    roots.push(root);
    let calls = 0;
    const provider: LanguageModelProvider = {
      async complete(request) {
        calls++;
        expect(request.mode).toBe("consistency");
        return {
          segments: [
            {
              id: request.segments[0].id,
              text: JSON.stringify({
                entries: [
                  {
                    source: "Vigilant",
                    target: "«Виджилент»",
                    category: "ship",
                    strategy: "transliteration",
                  },
                  { source: "Invented", target: "Выдумка", category: "other" },
                ],
              }),
            },
          ],
        };
      },
    };
    const input = documents().map((document) => ({ ...document, editedSegments: [] }));
    const args = [
      provider,
      { name: "resolver", endpoint: "local", model: "deepseek-v4-flash" },
      { tag: "en", name: "English" },
      { tag: "ru", name: "Russian" },
      input,
      root,
    ] as const;

    const first = await resolveEntityRegistry(...args);
    const second = await resolveEntityRegistry(...args);

    expect(first).toEqual([
      expect.objectContaining({ source: "Vigilant", target: "«Виджилент»", enabled: true }),
    ]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("keeps an explicit user glossary entry ahead of generated choices", () => {
    const user = [
      {
        id: "user-vigilant",
        source: "Vigilant",
        target: "«Виджилант»",
        category: "ship",
        enabled: true,
      },
    ];
    const generated = [
      {
        id: "generated-vigilant",
        source: "vigilant",
        target: "«Виджилент»",
        category: "ship",
        enabled: true,
      },
    ];

    expect(mergeGlossaries(user, generated)).toEqual(user);
  });
});
