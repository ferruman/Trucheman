import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  alignGlossaryVariants,
  alignNavigationLabels,
  applyConsistencyDecisions,
  buildConsistencyReport,
  extractEntityEvidence,
  extractRepeatedSourceEntities,
  glossaryAdherenceWarnings,
  measureGlossaryAdherence,
  mergeGlossaries,
  normalizeRussianConsistencyMechanics,
  resolveConsistencyConflicts,
  resolveEntityRegistry,
  type ConsistencyDocument,
} from "../../src/server/jobs/consistency-service.js";
import { targetLanguageProfile } from "../../src/server/config/target-language.js";
import type { LanguageModelProvider } from "../../src/server/providers/provider.js";

// Literary names and excerpts in this file come from the public-domain Alice fixture.
// Russian strings are repository-owned test translations. See tests/fixtures/NOTICE.md.

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
        sourceSegment("chapter:0", "The Hatter saw the Dormouse."),
        sourceSegment("chapter:1", "Later the Hatter woke the Dormouse."),
      ],
      editedSegments: [
        { id: "chapter:0", text: "Хэттер увидел Соню." },
        {
          id: "chapter:1",
          text: 'Позже Хаттер разбудил Дормауса в " Стране чудес »: тёмный темный.',
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
        expect.objectContaining({ source: "Hatter", occurrences: 2 }),
        expect.objectContaining({ source: "Dormouse", occurrences: 2 }),
      ]),
    );
    expect(entities.find((entry) => entry.source === "Hatter")?.contexts[0]?.target).toContain(
      "Хэттер",
    );
  });

  it("keeps repeated names isolated by EPUB markup", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "isolated",
        sourceSegments: [
          sourceSegment("isolated:0", "White Rabbit"),
          sourceSegment("isolated:1", "White Rabbit"),
        ],
        editedSegments: [],
      },
    ];

    expect(extractRepeatedSourceEntities(values)).toContainEqual(
      expect.objectContaining({ source: "White Rabbit", occurrences: 2 }),
    );
  });

  it("extracts high-confidence street names even when they occur once", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "streets",
        sourceSegments: [sourceSegment("streets:0", "Alice crossed Queen\nStreet.")],
        editedSegments: [],
      },
    ];

    expect(extractRepeatedSourceEntities(values)).toContainEqual(
      expect.objectContaining({ source: "Queen Street", occurrences: 1 }),
    );
  });

  it("reports quote and yo inconsistencies without rewriting prose", () => {
    const report = buildConsistencyReport(documents());

    expect(report.documents[0].quotes.balanced).toBe(false);
    expect(report.documents[0].yo.variants).toContainEqual({
      key: "темный",
      variants: ["темный", "тёмный"],
    });
    expect(report.warningCount).toBeGreaterThan(0);
  });

  it("does not read an ё homograph pair as a spelling inconsistency", () => {
    const report = buildConsistencyReport([
      {
        id: "homographs",
        sourceSegments: [],
        editedSegments: [
          { id: "homographs:0", text: "Все ушли, и всё стало тихо." },
          { id: "homographs:1", text: "О чём он думал и чем это кончилось?" },
        ],
      },
    ]);

    expect(report.documents[0].yo.variants).toEqual([]);
    expect(report.warningCount).toBe(0);
  });

  it("normalizes Russian quote mechanics and coordinate minute marks", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "mechanics",
        sourceSegments: [],
        editedSegments: [
          {
            id: "mechanics:0",
            text: '« Белый Кролик » и « Чеширский Кот "; " Страна чудес ". 49° 51´, 47°9\'.',
          },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBeGreaterThan(0);
    expect(values[0].editedSegments[0].text).toBe(
      "«Белый Кролик» и «Чеширский Кот»; «Страна чудес». 49° 51′, 47° 9′.",
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
          { id: "split-quotes:1", text: "Белый Кролик" },
          { id: "split-quotes:2", text: '", "' },
          { id: "split-quotes:3", text: "Чеширский Кот" },
          { id: "split-quotes:4", text: '".' },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBe(4);
    expect(values[0].editedSegments.map((segment) => segment.text).join("")).toBe(
      "Он услышал: «Белый Кролик», «Чеширский Кот».",
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
          { id: "inline-title:1", text: "Алиса в Стране чудес" },
          { id: "inline-title:2", text: " для чтения." },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBe(1);
    expect(values[0].editedSegments.map((segment) => segment.text).join("")).toBe(
      "Электронная книга «Алиса в Стране чудес» для чтения.",
    );
  });

  it("reunites a reply that was closed before its attribution and reopened without «", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "dialogue",
        sourceSegments: [],
        editedSegments: [
          {
            id: "dialogue:0",
            text: "«Ах, боже мой!» — воскликнул Кролик. — Я опоздаю! Герцогиня будет в ярости».",
          },
          {
            id: "dialogue:1",
            text: "«Ну же!» — сказала Алиса. — Нет никакого смысла так плакать! Сейчас же перестань!»",
          },
          { id: "dialogue:2", text: "«Ключ слишком мал, Алиса», — сказал он." },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBe(2);
    expect(values[0].editedSegments[0].text).toBe(
      "«Ах, боже мой! — воскликнул Кролик. — Я опоздаю! Герцогиня будет в ярости».",
    );
    expect(values[0].editedSegments[1].text).toBe(
      "«Ну же! — сказала Алиса. — Нет никакого смысла так плакать! Сейчас же перестань!»",
    );
    // A reply that was already correct is left exactly as it is.
    expect(values[0].editedSegments[2].text).toBe("«Ключ слишком мал, Алиса», — сказал он.");
    expect(buildConsistencyReport(values).documents[0].quotes.balanced).toBe(true);
  });

  it("collapses duplicate guillemets around an already quoted title", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "nested-quotes",
        sourceSegments: [],
        editedSegments: [
          {
            id: "nested-quotes:0",
            text: "Она вошла в ««Кроличью нору»». Затем прочитала ««Море слёз»».",
          },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBe(4);
    expect(values[0].editedSegments[0].text).toBe(
      "Она вошла в «Кроличью нору». Затем прочитала «Море слёз».",
    );
  });

  it("does not call multi-paragraph direct speech unbalanced", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "speech",
        sourceSegments: [],
        editedSegments: [
          { id: "speech:0", text: "«Знаешь, не проходит ни дня, ни часа." },
          { id: "speech:1", text: "«Мы построили этот дом вместе." },
          { id: "speech:2", text: "«И хочешь не хочешь, а жить надо»." },
          { id: "speech:3", text: "А потом она замолчала»." },
        ],
      },
    ];

    const quotes = buildConsistencyReport(values).documents[0].quotes;

    // Two paragraph-initial « continue one quotation; the trailing » closes nothing.
    expect(quotes).toMatchObject({ continuations: 2, unmatchedOpenings: 0, unmatchedClosings: 1 });
    expect(quotes.balanced).toBe(false);
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
      { source: "Hatter", canonical: "Хаттер", variants: ["Хэттер"] },
      { source: "NotPresent", canonical: "Канон", variants: ["Профессор"] },
    ]);

    expect(applied).toBe(1);
    expect(values[0].editedSegments[0].text).toContain("Хаттер увидел");
    expect(values[0].editedSegments[0].text).not.toContain("Канон");
  });

  it("does not nest a quoted canonical inside existing guillemets", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "quoted-title",
        sourceSegments: [sourceSegment("quoted-title:0", "She read Down the Rabbit-Hole.")],
        editedSegments: [
          {
            id: "quoted-title:0",
            text: "Она прочитала «Вниз по кроличьей норе». Затем открыла «Море слёз».",
          },
        ],
      },
    ];

    const applied = applyConsistencyDecisions(values, [
      {
        source: "Down the Rabbit-Hole",
        canonical: "«Вниз по кроличьей норе»",
        variants: ["Вниз по кроличьей норе"],
      },
      { source: "Pool of Tears", canonical: "«Море слёз»", variants: ["Море слёз"] },
    ]);

    expect(applied).toBe(1);
    expect(values[0].editedSegments[0].text).toBe(
      "Она прочитала «Вниз по кроличьей норе». Затем открыла «Море слёз».",
    );
  });

  it("never lets a decision replace the space around a name", () => {
    // A resolver variant with a trailing space must not consume the real separator.
    const values: ConsistencyDocument[] = [
      {
        id: "padded",
        sourceSegments: [sourceSegment("padded:0", "The White Rabbit’s hurried voice carried.")],
        editedSegments: [{ id: "padded:0", text: "Белый Кролик торопливо пробежал по коридору." }],
      },
    ];

    const applied = applyConsistencyDecisions(values, [
      {
        source: "White Rabbit",
        canonical: "Белый Кролик",
        variants: ["Белый Кролик ", "Белый Кролик"],
      },
    ]);

    expect(values[0].editedSegments[0].text).toContain("Кролик торопливо");
    expect(values[0].editedSegments[0].text).not.toContain("Кроликторопливо");
    expect(applied).toBe(0);
  });

  it("never lets resolver decisions rename an entity", () => {
    // Overlapping public-domain character names exercise rename cascades.
    const values: ConsistencyDocument[] = [
      {
        id: "rename",
        sourceSegments: [
          sourceSegment("rename:0", "Turtle crossed the hall. Mock Turtle said nothing."),
          sourceSegment("rename:1", "“Not now, Mock,” Turtle said to Alice."),
        ],
        editedSegments: [
          { id: "rename:0", text: "Черепаха пересекла зал. Ложная Черепаха промолчала." },
          { id: "rename:1", text: "«Не сейчас, Ложная», — сказала Черепаха Алисе." },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        {
          source: "Turtle",
          canonical: "Черепаха",
          variants: ["Ложная Черепаха", "Черепаха Алисе"],
        },
        {
          source: "Mock Turtle",
          canonical: "Ложная Черепаха",
          variants: ["Черепаха", "Ложная"],
        },
        { source: "Mock", canonical: "Ложная", variants: ["Черепаха"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(text).toContain("Черепаха пересекла");
    // The surname is neither dropped from the full name nor added to the bare one.
    expect(text).toContain("Ложная Черепаха промолчала");
    expect(text).toContain("сказала Черепаха Алисе");
    // The nickname keeps its own rendering.
    expect(text).toContain("«Не сейчас, Ложная»");
  });

  it("never lets resolver decisions re-inflect an entity", () => {
    // Public-domain Alice terms model a resolver replacing inflected text with nominatives.
    const values: ConsistencyDocument[] = [
      {
        id: "inflect",
        sourceSegments: [
          sourceSegment("inflect:0", "the golden key. The Duchess refused."),
          sourceSegment(
            "inflect:1",
            "advice from the Caterpillar, permission from the Queen of Hearts",
          ),
          sourceSegment("inflect:2", "the cat Dinah followed"),
        ],
        editedSegments: [
          { id: "inflect:0", text: "золотого ключа. Герцогиня отказалась." },
          {
            id: "inflect:1",
            text: "совета от Гусеницы, разрешение от Червонной Королевы",
          },
          { id: "inflect:2", text: "кошка Дина последовала" },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        { source: "golden key", canonical: "золотой ключ", variants: ["золотого ключа"] },
        { source: "Duchess", canonical: "Герц.", variants: ["Герцогиня"] },
        { source: "Caterpillar", canonical: "ГУСЕНИЦА", variants: ["Гусеницы"] },
        {
          source: "Queen of Hearts",
          canonical: "Червонная Королева",
          variants: ["Червонной Королевы"],
        },
        { source: "Dinah", canonical: "«Дина»", variants: ["Дина"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    // An adjective is not a declension of its noun, and a word is not its abbreviation.
    expect(text).toContain("золотого ключа");
    expect(text).toContain("Герцогиня отказалась");
    // A phrase in the prepositional case is not the heading it was taken from.
    expect(text).toContain("совета от Гусеницы");
    expect(text).toContain("от Червонной Королевы");
    // Adding the marks around a title is still a respelling, and still applies.
    expect(text).toContain("кошка «Дина» последовала");
  });

  it("never lets a decision drop the marks around a variant", () => {
    // Alice terms model lost guillemets and a compound accidentally joined by a hyphen.
    const values: ConsistencyDocument[] = [
      {
        id: "marks",
        sourceSegments: [
          sourceSegment("marks:0", "“Oh dear! Oh dear!” the Rabbit cried. “I shall be late!”"),
          sourceSegment("marks:1", "Alice carried the Marmalade jar past the Rabbit-Hole."),
        ],
        editedSegments: [
          { id: "marks:0", text: "«Ах, боже!» — воскликнул Кролик. «Я опоздаю»." },
          { id: "marks:1", text: "Алиса несла банку «Мармелад» мимо кроличьей-норы." },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        { source: "Oh dear", canonical: "Ах, боже", variants: ["«Ах, боже", "Ах, боже!"] },
        { source: "Marmalade", canonical: "Мармелад", variants: ["«Мармелад»"] },
        { source: "Rabbit-Hole", canonical: "кроличья нора", variants: ["кроличьей-"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(text).toContain("«Ах, боже!»");
    expect(text).toContain("банку «Мармелад» мимо");
    expect(text).toContain("кроличьей-норы");
  });

  it("carries an accepted decision to declined forms and leaves the canonical's own alone", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "carry",
        sourceSegments: [
          sourceSegment("carry:0", "Dinah waited. They followed Dinah past the little door."),
          sourceSegment("carry:1", "Alice waited. Dinah gave it to Alice."),
        ],
        editedSegments: [
          { id: "carry:0", text: "Дайна ждала. Пошли за Дайной к маленькой двери." },
          { id: "carry:1", text: "Алиса ждала. Дина отдала это Алисе." },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        { source: "Dinah", canonical: "Дина", variants: ["Дайна"] },
        // The resolver routinely offers the canonical's own declensions as variants.
        { source: "Alice", canonical: "Алиса", variants: ["Алисе"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(text).toContain("Дина ждала");
    expect(text).toContain("за Диной");
    // Алисе is Алиса in the dative, not a competing spelling.
    expect(text).toContain("отдала это Алисе");
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
                    source: "Dormouse",
                    target: "Соня",
                    category: "person",
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

    expect(first.entries).toEqual([
      expect.objectContaining({ source: "Dormouse", target: "Соня", enabled: true }),
    ]);
    expect(first.failedChunks).toEqual([]);
    expect(second.entries).toEqual(first.entries);
    // The second run asks about nothing, so it has no chunks to resolve.
    expect(second.chunks).toBe(0);
    expect(calls).toBe(1);
  });

  it("halves a chunk whose answer the model could not return whole", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-split-`);
    roots.push(root);
    const asked: number[] = [];
    const provider: LanguageModelProvider = {
      async complete(request) {
        const payload = JSON.parse(request.segments[0].text);
        asked.push(payload.entities.length);
        // What a real run returned for 25 entities: the answer itself ran past the output
        // limit and arrived cut off mid-string.
        if (payload.entities.length > 1)
          throw new Error(
            "Provider returned malformed structured output (39698 bytes, length: Unterminated string in JSON)",
          );
        return {
          segments: [
            {
              id: request.segments[0].id,
              text: JSON.stringify({
                entries: payload.entities.map((entity: { source: string }) => ({
                  source: entity.source,
                  target: `${entity.source}-ru`,
                  category: "person",
                })),
              }),
            },
          ],
        };
      },
    };

    const registry = await resolveEntityRegistry(
      provider,
      { name: "resolver", endpoint: "local", model: "deepseek-v4-flash" },
      { tag: "en", name: "English" },
      { tag: "ru", name: "Russian" },
      documents().map((document) => ({ ...document, editedSegments: [] })),
      root,
    );

    // The whole chunk, then each half; nothing is abandoned, so no name is left to vary.
    expect(asked).toEqual([2, 1, 1]);
    expect(registry.failedChunks).toEqual([]);
    expect(registry.resolvedChunks).toBe(1);
    expect(registry.entries.map((entry) => entry.source).sort()).toEqual(["Dormouse", "Hatter"]);
  });

  it("gives up on a chunk that is not failing on size, without quartering it", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-hopeless-`);
    roots.push(root);
    let calls = 0;
    const provider: LanguageModelProvider = {
      async complete() {
        calls++;
        throw new Error("Provider returned an empty response");
      },
    };

    const registry = await resolveEntityRegistry(
      provider,
      { name: "resolver", endpoint: "local", model: "deepseek-v4-flash" },
      { tag: "en", name: "English" },
      { tag: "ru", name: "Russian" },
      documents().map((document) => ({ ...document, editedSegments: [] })),
      root,
    );

    expect(calls).toBe(3);
    expect(registry.resolvedChunks).toBe(0);
    expect(registry.failedChunks.map((failure) => failure.chunk)).toEqual(["1.1", "1.2"]);
  });

  it("accepts a registry answer that drops the wrapper object", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-bare-`);
    roots.push(root);
    const provider: LanguageModelProvider = {
      async complete(request) {
        return {
          segments: [
            {
              id: request.segments[0].id,
              // The bare array the model sometimes answers with instead of {"entries": [...]}.
              text: JSON.stringify([{ source: "Dormouse", target: "Соня", category: "person" }]),
            },
          ],
        };
      },
    };
    const registry = await resolveEntityRegistry(
      provider,
      { name: "resolver", endpoint: "local", model: "deepseek-v4-flash" },
      { tag: "en", name: "English" },
      { tag: "ru", name: "Russian" },
      documents().map((document) => ({ ...document, editedSegments: [] })),
      root,
    );

    expect(registry.failedChunks).toEqual([]);
    expect(registry.entries).toEqual([
      expect.objectContaining({ source: "Dormouse", target: "Соня", enabled: true }),
    ]);
  });

  it("keeps a settled canonical when new entities appear alongside it", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-stable-`);
    roots.push(root);
    const asked: string[][] = [];
    let answer = "Алиса";
    const provider: LanguageModelProvider = {
      async complete(request) {
        const payload = JSON.parse(request.segments[0].text);
        const sources = payload.entities.map((entity: { source: string }) => entity.source);
        asked.push(sources);
        return {
          segments: [
            {
              id: request.segments[0].id,
              text: JSON.stringify({
                entries: sources.map((source: string) => ({
                  source,
                  target: source === "Alice" ? answer : source,
                  category: "person",
                })),
              }),
            },
          ],
        };
      },
    };
    const book = (extra: string[]): ConsistencyDocument[] => [
      {
        id: "book",
        sourceSegments: ["Alice", ...extra].flatMap((name, index) => [
          sourceSegment(`book:${index * 2}`, `At dawn, ${name} arrived.`),
          sourceSegment(`book:${index * 2 + 1}`, `Later, ${name} left again.`),
        ]),
        editedSegments: [],
      },
    ];
    const profile = { name: "resolver", endpoint: "local", model: "m" };
    const languages = [
      { tag: "en", name: "English" },
      { tag: "ru", name: "Russian" },
    ] as const;

    const first = await resolveEntityRegistry(provider, profile, ...languages, book([]), root);
    // The model would answer differently now, and a new entity forces a second request.
    answer = "Элис";
    const second = await resolveEntityRegistry(
      provider,
      { ...profile, model: "another-model" },
      ...languages,
      book(["Cheshire"]),
      root,
    );

    expect(first.entries[0]).toMatchObject({ source: "Alice", target: "Алиса" });
    // Alice was settled; only the new entity is asked about, so her rendering cannot flip.
    expect(asked).toEqual([["Alice"], ["Cheshire"]]);
    expect(second.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "Alice", target: "Алиса" }),
        expect.objectContaining({ source: "Cheshire" }),
      ]),
    );
  });

  it("builds the entity registry in chunks and keeps the chunks that succeeded", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-chunks-`);
    roots.push(root);
    const names = ["Alice", "Dinah", "Hatter", "Cheshire"];
    const provider: LanguageModelProvider = {
      async complete(request) {
        const payload = JSON.parse(request.segments[0].text);
        // Every request naming Hatter times out, so halving the chunk cannot rescue it and the
        // failure is reported rather than retried away.
        if (payload.entities.some((entity: { source: string }) => entity.source === "Hatter"))
          throw new Error("Provider request timed out");
        return {
          segments: [
            {
              id: request.segments[0].id,
              text: JSON.stringify({
                entries: payload.entities.map((entity: { source: string }) => ({
                  source: entity.source,
                  target: entity.source.toLocaleUpperCase(),
                  category: "person",
                })),
              }),
            },
          ],
        };
      },
    };
    const input: ConsistencyDocument[] = [
      {
        id: "book",
        sourceSegments: names.flatMap((name, index) => [
          sourceSegment(`book:${index * 2}`, `${name} arrived at dawn.`),
          sourceSegment(`book:${index * 2 + 1}`, `Later ${name} left again.`),
        ]),
        editedSegments: [],
      },
    ];

    const registry = await resolveEntityRegistry(
      provider,
      { name: "resolver", endpoint: "local", model: "m" },
      { tag: "en", name: "English" },
      { tag: "ru", name: "Russian" },
      input,
      root,
      undefined,
      2,
    );

    expect(registry.chunks).toBe(2);
    expect(registry.resolvedChunks).toBe(1);
    expect(registry.failedChunks).toEqual([{ chunk: "2.2", error: "Provider request timed out" }]);
    // Neither the other chunk's entries nor the half that answered are lost with it.
    expect(registry.entries.map((entry) => entry.source).sort()).toEqual([
      "Alice",
      "Cheshire",
      "Dinah",
    ]);
  });

  it("keeps an explicit user glossary entry ahead of generated choices", () => {
    const user = [
      {
        id: "user-white-rabbit",
        source: "White Rabbit",
        target: "«Белый Кролик»",
        category: "ship",
        enabled: true,
      },
    ];
    const generated = [
      {
        id: "generated-white-rabbit",
        source: "white rabbit",
        target: "«Белый Кролик»",
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
          sourceSegment("noise:0", "She walked on. The wind rose. But Alice waited for Hatter."),
          sourceSegment("noise:1", "She saw the wind and knew that Alice had left with Hatter."),
          sourceSegment("noise:2", "they saw her wind but she waited."),
        ],
        editedSegments: [],
      },
    ];
    const { entities, stats } = extractEntityEvidence(values);
    const sources = entities.map((entity) => entity.source);

    expect(sources).toEqual(expect.arrayContaining(["Alice", "Hatter"]));
    for (const noise of ["She", "The", "But", "Wind"]) expect(sources).not.toContain(noise);
    expect(stats.stopWords + stats.commonWords).toBeGreaterThan(0);
    expect(stats.kept).toBe(entities.length);
  });

  it("extracts a multi-word name as one entity instead of its separate words", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "phrases",
        sourceSegments: [
          sourceSegment("phrases:0", "Alice met the Queen of Hearts near the Pool of Tears."),
          sourceSegment("phrases:1", "The Queen of Hearts saw the White Rabbit. Alice waited."),
          sourceSegment("phrases:2", "The Queen of Hearts’s crown was gone."),
          sourceSegment("phrases:3", "Then Alice left the Pool of Tears alone."),
        ],
        editedSegments: [],
      },
    ];

    const sources = extractRepeatedSourceEntities(values).map((entity) => entity.source);

    expect(sources).toContain("Queen of Hearts");
    expect(sources).toContain("Pool of Tears");
    // A sentence opening is not part of the name, and the possessive is the same entity.
    expect(sources).not.toContain("Then Alice");
    expect(sources).not.toContain("Queen of Hearts’s");
    // A run must not cross a sentence boundary: "Rabbit. Alice" is two entities.
    expect(sources).not.toContain("Rabbit Alice");
    expect(
      extractRepeatedSourceEntities(values).find((entity) => entity.source === "Queen of Hearts")
        ?.occurrences,
    ).toBe(3);
  });

  it("strips a possessive or a contraction that a full stop hid behind", () => {
    // A possessive at a sentence boundary must not enter the registry as a separate entity.
    const values = [
      {
        id: "clitics",
        sourceSegments: [
          sourceSegment("clitics:0", "Alice saw Rabbit. She had followed Rabbit’s."),
          sourceSegment("clitics:1", "Rabbit’s. Alice ran. I’m sure they’ve gone."),
          sourceSegment("clitics:2", "Rabbit waited, and I’m certain they’ve waited too."),
          sourceSegment("clitics:3", "Didn’t she run? Shouldn’t she? Didn’t Rabbit wait?"),
        ],
        editedSegments: [],
      },
    ];

    const sources = extractRepeatedSourceEntities(values).map((entity) => entity.source);

    expect(sources).toContain("Rabbit");
    expect(sources).not.toContain("Rabbit’s");
    expect(sources).not.toContain("I’m");
    expect(sources).not.toContain("They’ve");
    // n’t belongs to the verb: stripping it leaves "Didn", which no filter recognizes.
    expect(sources).not.toContain("Didn");
    expect(sources).not.toContain("Shouldn");
  });

  it("keeps a name the book also spells as a common noun", () => {
    // Alice uses Mouse as a character name and mouse as an ordinary noun.
    const named = (times: number, text: string) =>
      Array.from({ length: times }, (_, index) => sourceSegment(`mouse:${text}${index}`, text));
    const values: ConsistencyDocument[] = [
      {
        id: "mouse",
        sourceSegments: [
          ...named(8, "Alice saw Mouse swimming across the pool."),
          ...named(1, "A mouse slipped into the pool."),
          // Capitalized often enough to clear the floor, nowhere near often enough to clear
          // the margin: an ordinary noun that a few sentences happen to dress up.
          ...named(6, "Alice saw the Question and looked away."),
          ...named(12, "The question was odd, and the question was brief."),
        ],
        editedSegments: [],
      },
    ];

    const sources = extractRepeatedSourceEntities(values).map((entity) => entity.source);

    expect(sources).toContain("Mouse");
    expect(sources).not.toContain("Question");
  });

  it("resolves consistency in chunks and keeps decisions when one chunk fails", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-consistency-chunks-`);
    roots.push(root);
    const names = ["Alice", "Dinah", "Hatter", "Cheshire", "Dormouse"];
    const canonical: Record<string, string> = {
      Alice: "Алиса",
      Dinah: "Дина",
      Hatter: "Шляпник",
      Cheshire: "Чеширец",
      Dormouse: "Дормаус",
    };
    const variants: Record<string, string> = {
      Alice: "Элис",
      Dinah: "Дайна",
      Hatter: "Хаттер",
      Cheshire: "Чиширец",
      Dormouse: "Дормоус",
    };
    const values: ConsistencyDocument[] = [
      {
        id: "book",
        sourceSegments: names.flatMap((name, index) => [
          sourceSegment(`book:${index * 2}`, `At dawn, ${name} arrived.`),
          sourceSegment(`book:${index * 2 + 1}`, `Later, ${name} left again.`),
        ]),
        editedSegments: names.flatMap((name, index) => [
          { id: `book:${index * 2}`, text: `${canonical[name]} прибыл на рассвете.` },
          { id: `book:${index * 2 + 1}`, text: `Позже ${variants[name]} снова ушёл.` },
        ]),
      },
    ];

    const provider: LanguageModelProvider = {
      async complete(request) {
        const payload = JSON.parse(request.segments[0].text);
        // Every request naming Hatter times out, so halving the chunk cannot rescue it either.
        if (
          payload.report.entityEvidence.some(
            (entity: { source: string }) => entity.source === "Hatter",
          )
        )
          throw new Error("Provider request timed out");
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
    expect(resolution.failedChunks.map((failure) => failure.error)).toEqual([
      "Provider request timed out",
    ]);
    // One entity the model cannot answer for must not cancel the decisions of the others.
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

    // Answers are persisted per entity as each chunk completes, so a rerun only retries
    // the entities whose chunk failed.
    const cache = JSON.parse(await readFile(`${root}/consistency-resolution.json`, "utf8"));
    // Five entities in chunks of two. The chunk holding Hatter failed, but halving it saved
    // the entity it was paired with, so only Hatter itself is left unanswered.
    expect(Object.keys(cache.value.entities)).toHaveLength(4);
  });

  it("aligns name variants from the glossary when the resolver is unavailable", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "fallback",
        sourceSegments: [
          sourceSegment("fallback:0", "Dinah waited. Dinah waited. Dinah left."),
          sourceSegment("fallback:1", "Lorina called Dinah. Lorina said nothing."),
          sourceSegment("fallback:2", "Dinah had a plan."),
        ],
        editedSegments: [
          { id: "fallback:0", text: "Дайна ждала. Дина ждала. Дайна ушла." },
          { id: "fallback:1", text: "Лорина звала Дину. Ларина молчала. Лорина ушла." },
          { id: "fallback:2", text: "У Дины был план." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Dinah", target: "Дайна", category: "person", enabled: true },
      { id: "g2", source: "Lorina", target: "Лорина", category: "person", enabled: true },
    ];

    const result = alignGlossaryVariants(values, glossary);

    expect(result.applied).toBeGreaterThan(0);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");
    expect(text).not.toContain("Дина");
    expect(text).not.toContain("Ларина");
    // Without the Russian ending rules, inflected forms stay untouched.
    expect(text).toContain("Дины");
  });

  it("corrects the stem of a declined variant and keeps its case ending", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "inflected",
        // Both renderings are in use throughout, which is what an unresolved run looks like.
        sourceSegments: [
          sourceSegment("inflected:0", "Dinah waited. Dinah left. Dinah had a plan."),
          sourceSegment("inflected:1", "The Rabbit told Dinah about the little golden key."),
          sourceSegment("inflected:2", "Dinah saw it. They followed Dinah out of Dinah's house."),
          sourceSegment("inflected:3", "He looked at Lorina and Lorina was afraid."),
          sourceSegment("inflected:4", "Lorina knew. He gave it to Lorina and left Lorina."),
          sourceSegment("inflected:5", "Hatter hit Hare, and Hare said nothing to Hatter."),
          sourceSegment("inflected:6", "Hatter watched Hare. Hare nodded to Hatter."),
        ],
        editedSegments: [
          { id: "inflected:0", text: "Дина ждала. Динна ушла. У Дины был план." },
          { id: "inflected:1", text: "Кролик рассказал Дине о маленьком золотом ключе." },
          { id: "inflected:2", text: "Дина видела. Пошли за Диной из дома Динны к Динне." },
          { id: "inflected:3", text: "Он посмотрел на Лоррину, и Лоррине стало страшно." },
          { id: "inflected:4", text: "Лорина знала. Отдал Лорине и оставил Лорину." },
          { id: "inflected:5", text: "Хэттер ударил Заяца, и Заяц ничего не сказал Хэттеру." },
          { id: "inflected:6", text: "Хаттер смотрел на Заяца. Заяц кивнул Хаттеру." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Dinah", target: "Дина", category: "person", enabled: true },
      { id: "g2", source: "Lorina", target: "Лорина", category: "person", enabled: true },
      { id: "g3", source: "Hatter", target: "Хаттер", category: "person", enabled: true },
      { id: "g4", source: "Hare", target: "Заяц", category: "person", enabled: true },
    ];

    alignGlossaryVariants(values, glossary, targetLanguageProfile("ru").nameEndings);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(text).toContain("Дины");
    expect(text).toContain("Дине");
    expect(text).not.toMatch(/Динн[аыеуой]\b/u);
    // The whole point: a declined variant keeps its case, it is not flattened to the
    // nominative canonical the way "Он ударил Заяц по лицу" used to be.
    expect(text).toContain("на Лорину");
    expect(text).toContain("Лорине стало");
    expect(text).toContain("ударил Заяца");
    expect(text).toContain("сказал Хаттеру");
    expect(text).not.toMatch(/Лоррин|Хэттер/u);
  });

  it("never rewrites an ordinary word or an unrelated name that resembles a glossary entry", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "lookalikes",
        sourceSegments: [
          sourceSegment("lookalikes:0", "Lory watched. Children were playing outside."),
          sourceSegment("lookalikes:1", "Dodo nodded. Duchess walked into the hall."),
          sourceSegment("lookalikes:2", "Hatter turned. Matter filled the room."),
          sourceSegment("lookalikes:3", "The children ran to the demon."),
        ],
        editedSegments: [
          { id: "lookalikes:0", text: "Лори смотрел. Дети играли во дворе." },
          { id: "lookalikes:1", text: "Додо кивнул. Герцогиня вошла в зал." },
          { id: "lookalikes:2", text: "Шляпник обернулся. Материя заполнила комнату." },
          { id: "lookalikes:3", text: "Дети побежали к демону." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Lory", target: "Лори", category: "person", enabled: true },
      { id: "g2", source: "Dodo", target: "Додо", category: "person", enabled: true },
      { id: "g3", source: "Hatter", target: "Шляпник", category: "person", enabled: true },
    ];

    const result = alignGlossaryVariants(values, glossary, targetLanguageProfile("ru").nameEndings);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(result.replacements).toEqual([]);
    expect(text).toContain("Дети играли");
    expect(text).toContain("Герцогиня вошла");
    expect(text).toContain("Материя заполнила");
  });

  it("leaves a rare bystander name and a canonical the book never used alone", () => {
    const mentions = Array.from({ length: 60 }, (_, index) => index);
    const values: ConsistencyDocument[] = [
      {
        id: "rare",
        sourceSegments: [
          ...mentions.map((index) => sourceSegment(`rare:${index}`, `Rabbit spoke again.`)),
          sourceSegment("rare:60", "Rabbit looked at Bill."),
          sourceSegment("rare:61", "The looking-glass shimmered in the corner."),
        ],
        editedSegments: [
          ...mentions.map((index) => ({ id: `rare:${index}`, text: "Кролик снова заговорил." })),
          { id: "rare:60", text: "Кролик посмотрел на Билла." },
          { id: "rare:61", text: "Зеркалье мерцало в углу." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Rabbit", target: "Кролик", category: "person", enabled: true },
      // The registry misspelled this one; a canonical the book never uses is not authority.
      { id: "g2", source: "looking-glass", target: "Зазеркалье", category: "other", enabled: true },
    ];

    const result = alignGlossaryVariants(values, glossary, targetLanguageProfile("ru").nameEndings);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(result.replacements).toEqual([]);
    expect(text).toContain("на Билла");
    expect(text).toContain("Зеркалье мерцало");
  });

  it("measures how often the models actually used the glossary rendering", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "adherence",
        sourceSegments: [
          sourceSegment("adherence:0", "Alice waited."),
          sourceSegment("adherence:1", "Alice left."),
          sourceSegment("adherence:2", "Alice had a plan."),
          sourceSegment("adherence:3", "Dinah waited for Alice."),
        ],
        editedSegments: [
          { id: "adherence:0", text: "Элис ждала." },
          { id: "adherence:1", text: "Элис ушла." },
          { id: "adherence:2", text: "Алиса составила план." },
          { id: "adherence:3", text: "Дина ждала Элису." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Alice", target: "Алиса", category: "person", enabled: true },
      { id: "g2", source: "Dinah", target: "Дина", category: "person", enabled: true },
    ];

    const adherence = measureGlossaryAdherence(values, glossary);

    expect(adherence).toContainEqual({
      source: "Alice",
      target: "Алиса",
      blocks: 4,
      blocksUsingTarget: 1,
    });
    expect(glossaryAdherenceWarnings(adherence).map((entry) => entry.source)).toEqual(["Alice"]);
  });

  it("counts a declined, quoted or multi-word glossary target as adherence", () => {
    // Public-domain Alice terms appear only in declined or quoted forms.
    const values: ConsistencyDocument[] = [
      {
        id: "inflected",
        sourceSegments: [
          sourceSegment("inflected:0", "in the garden, through the Rabbit-Hole"),
          sourceSegment("inflected:1", "the golden key of the White Rabbit"),
          sourceSegment("inflected:2", "the cat Dinah"),
        ],
        editedSegments: [
          { id: "inflected:0", text: "в саду, через Кроличью нору" },
          { id: "inflected:1", text: "золотого ключа Белого Кролика" },
          { id: "inflected:2", text: "кошки «Дины»" },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "garden", target: "сад", category: "place", enabled: true },
      {
        id: "g2",
        source: "Rabbit-Hole",
        target: "Кроличья нора",
        category: "place",
        enabled: true,
      },
      { id: "g3", source: "golden key", target: "золотой ключ", category: "term", enabled: true },
      {
        id: "g4",
        source: "White Rabbit",
        target: "Белый Кролик",
        category: "person",
        enabled: true,
      },
      { id: "g5", source: "Dinah", target: "«Дина»", category: "person", enabled: true },
    ];

    const adherence = measureGlossaryAdherence(values, glossary);

    for (const entry of adherence) expect(entry).toMatchObject({ blocksUsingTarget: entry.blocks });
    expect(glossaryAdherenceWarnings(adherence)).toEqual([]);
  });

  it("makes the NCX navMap the authority for a table-of-contents label", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "ncx",
        sourceSegments: [sourceSegment("ncx:0", "CHAPTER I. Down the Rabbit-Hole")],
        editedSegments: [{ id: "ncx:0", text: "ГЛАВА I. Вниз по кроличьей норе" }],
      },
      {
        id: "nav",
        sourceSegments: [sourceSegment("nav:0", "CHAPTER I. Down the Rabbit-Hole")],
        editedSegments: [{ id: "nav:0", text: "Глава вторая. Среди песков" }],
      },
      {
        id: "chapter",
        sourceSegments: [
          sourceSegment("chapter:0", " CHAPTER I.  Down the Rabbit-Hole "),
          sourceSegment("chapter:1", "The wind never stopped."),
        ],
        editedSegments: [
          { id: "chapter:0", text: " Вниз по кроличьей норе " },
          { id: "chapter:1", text: "Ветер не стихал." },
        ],
      },
    ];

    const result = alignNavigationLabels(
      values,
      new Map([
        ["ncx", "ncx"],
        ["nav", "nav"],
        ["chapter", null],
      ]),
    );

    expect(result.applied).toBe(2);
    expect(values[1].editedSegments[0].text).toBe("ГЛАВА I. Вниз по кроличьей норе");
    // Surrounding whitespace of the original text node is preserved.
    expect(values[2].editedSegments[0].text).toBe(" ГЛАВА I. Вниз по кроличьей норе ");
    // Prose that never appears in a navigation document is left alone.
    expect(values[2].editedSegments[1].text).toBe("Ветер не стихал.");
  });
});
