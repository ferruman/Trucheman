import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  alignGlossaryVariants,
  applyConsistencyDecisions,
  buildConsistencyReport,
  extractEntityEvidence,
  extractRepeatedSourceEntities,
  mergeGlossaries,
  normalizeRussianConsistencyMechanics,
  resolveConsistencyConflicts,
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

  it("keeps repeated names isolated by EPUB markup", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "isolated",
        sourceSegments: [
          sourceSegment("isolated:0", "Vigilant"),
          sourceSegment("isolated:1", "Vigilant"),
        ],
        editedSegments: [],
      },
    ];

    expect(extractRepeatedSourceEntities(values)).toContainEqual(
      expect.objectContaining({ source: "Vigilant", occurrences: 2 }),
    );
  });

  it("extracts high-confidence street names even when they occur once", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "streets",
        sourceSegments: [sourceSegment("streets:0", "He lived in Waterman\nStreet.")],
        editedSegments: [],
      },
    ];

    expect(extractRepeatedSourceEntities(values)).toContainEqual(
      expect.objectContaining({ source: "Waterman Street", occurrences: 1 }),
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

  it("normalizes Russian quote mechanics and coordinate minute marks", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "mechanics",
        sourceSegments: [],
        editedSegments: [
          {
            id: "mechanics:0",
            text: '« Ктулху » и « Р’льех "; " Ктулху фхтагн ". 49° 51´, 47°9\'.',
          },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBeGreaterThan(0);
    expect(values[0].editedSegments[0].text).toBe(
      "«Ктулху» и «Р’льех»; «Ктулху фхтагн». 49° 51′, 47° 9′.",
    );
    expect(buildConsistencyReport(values).documents[0].quotes).toMatchObject({
      balanced: true,
      straight: 0,
    });
  });

  it("normalizes quote pairs split across XHTML text nodes", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "split-quotes",
        sourceSegments: [],
        editedSegments: [
          { id: "split-quotes:0", text: 'Он услышал: "' },
          { id: "split-quotes:1", text: "Ктулху фхтагн" },
          { id: "split-quotes:2", text: '", "' },
          { id: "split-quotes:3", text: "Р’льех" },
          { id: "split-quotes:4", text: '".' },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBe(4);
    expect(values[0].editedSegments.map((segment) => segment.text).join("")).toBe(
      "Он услышал: «Ктулху фхтагн», «Р’льех».",
    );
    expect(buildConsistencyReport(values).documents[0].quotes.balanced).toBe(true);
  });

  it("closes a dangling guillemet around a short inline title node", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "inline-title",
        sourceSegments: [],
        editedSegments: [
          { id: "inline-title:0", text: "Электронная книга «" },
          { id: "inline-title:1", text: "Зов Ктулху" },
          { id: "inline-title:2", text: " для чтения." },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBe(1);
    expect(values[0].editedSegments.map((segment) => segment.text).join("")).toBe(
      "Электронная книга «Зов Ктулху» для чтения.",
    );
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

  it("keeps pronouns, articles, and ordinary words out of the entity registry", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "noise",
        sourceSegments: [
          sourceSegment("noise:0", "She walked on. The wind rose. But Kyra waited for Damon."),
          sourceSegment("noise:1", "She saw the wind and knew that Kyra had left with Damon."),
          sourceSegment("noise:2", "they saw her wind but she waited."),
        ],
        editedSegments: [],
      },
    ];
    const { entities, stats } = extractEntityEvidence(values);
    const sources = entities.map((entity) => entity.source);

    expect(sources).toEqual(expect.arrayContaining(["Kyra", "Damon"]));
    for (const noise of ["She", "The", "But", "Wind"]) expect(sources).not.toContain(noise);
    expect(stats.stopWords + stats.commonWords).toBeGreaterThan(0);
    expect(stats.kept).toBe(entities.length);
  });

  it("resolves consistency in chunks and keeps decisions when one chunk fails", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-consistency-chunks-`);
    roots.push(root);
    const names = ["Kyra", "Leticia", "Damon", "Raymondo", "Spain"];
    const canonical: Record<string, string> = {
      Kyra: "Кайра",
      Leticia: "Летиция",
      Damon: "Деймон",
      Raymondo: "Раймондо",
      Spain: "Спайн",
    };
    const variants: Record<string, string> = {
      Kyra: "Кира",
      Leticia: "Летисия",
      Damon: "Дэймон",
      Raymondo: "Рэймондо",
      Spain: "Спэйн",
    };
    const values: ConsistencyDocument[] = [
      {
        id: "book",
        sourceSegments: names.flatMap((name, index) => [
          sourceSegment(`book:${index * 2}`, `${name} arrived at dawn.`),
          sourceSegment(`book:${index * 2 + 1}`, `Later ${name} left again.`),
        ]),
        editedSegments: names.flatMap((name, index) => [
          { id: `book:${index * 2}`, text: `${canonical[name]} прибыл на рассвете.` },
          { id: `book:${index * 2 + 1}`, text: `Позже ${variants[name]} снова ушёл.` },
        ]),
      },
    ];

    let call = 0;
    const provider: LanguageModelProvider = {
      async complete(request) {
        call++;
        // The second chunk always times out, exactly like the production run.
        if (call === 2) throw new Error("Provider request timed out");
        const payload = JSON.parse(request.segments[0].text);
        return {
          segments: [
            {
              id: request.segments[0].id,
              text: JSON.stringify({
                decisions: payload.report.entityEvidence.map((entity: { source: string }) => ({
                  source: entity.source,
                  canonical: canonical[entity.source],
                  variants: [variants[entity.source]],
                })),
              }),
            },
          ],
          finishReason: "stop",
        };
      },
    };

    const report = buildConsistencyReport(values);
    const resolution = await resolveConsistencyConflicts(
      provider,
      { name: "consistency", endpoint: "local", model: "m" },
      { tag: "en", name: "English" },
      { tag: "ru", name: "Russian" },
      report,
      root,
      undefined,
      2,
    );

    expect(resolution.chunks).toBe(Math.ceil(report.entityEvidence.length / 2));
    expect(resolution.failedChunks).toEqual([{ chunk: 2, error: "Provider request timed out" }]);
    // One failed chunk must not cancel the decisions the other chunks produced.
    expect(resolution.resolvedChunks).toBe(resolution.chunks - 1);
    expect(resolution.decisions.length).toBeGreaterThan(0);

    const applied = applyConsistencyDecisions(values, resolution.decisions);
    expect(applied).toBeGreaterThan(0);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");
    const resolved = resolution.decisions.map((decision) => decision.source);
    for (const name of resolved) {
      expect(text).toContain(canonical[name]);
      expect(text).not.toContain(variants[name]);
    }

    // Successful chunks are persisted as they complete, so a rerun only retries the failure.
    const cache = JSON.parse(await readFile(`${root}/consistency-resolution.json`, "utf8"));
    expect(Object.keys(cache.value.chunks)).toHaveLength(resolution.resolvedChunks);
  });

  it("aligns name variants from the glossary when the resolver is unavailable", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "fallback",
        sourceSegments: [],
        editedSegments: [
          { id: "fallback:0", text: "Кайра ждала. Кира ждала. Кайра ушла." },
          { id: "fallback:1", text: "Летиция звала Кира. Летисия молчала. Летиция ушла." },
          { id: "fallback:2", text: "У Киры был план." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Kyra", target: "Кайра", category: "person", enabled: true },
      { id: "g2", source: "Leticia", target: "Летиция", category: "person", enabled: true },
    ];

    const result = alignGlossaryVariants(values, glossary);

    expect(result.applied).toBeGreaterThan(0);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");
    expect(text).not.toContain("Кира");
    expect(text).not.toContain("Летисия");
    // Inflected forms are a different word, not a variant, and must survive untouched.
    expect(text).toContain("Киры");
  });
});
