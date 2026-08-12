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

  it("reunites a reply that was closed before its attribution and reopened without «", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "dialogue",
        sourceSegments: [],
        editedSegments: [
          {
            id: "dialogue:0",
            text: "«Что-нибудь интересное», — повторила Эмили. — А теперь тебе лучше отправляться. Ехать далеко, а у меня встреча с заведующим кафедрой».",
          },
          {
            id: "dialogue:1",
            text: "«О, да!» — закричал Джонни. — Это моя жена! Это девушка, на которой я женился!»",
          },
          { id: "dialogue:2", text: "«Она бесполезна, Кайра», — сказал он." },
        ],
      },
    ];

    expect(normalizeRussianConsistencyMechanics(values)).toBe(2);
    expect(values[0].editedSegments[0].text).toBe(
      "«Что-нибудь интересное, — повторила Эмили. — А теперь тебе лучше отправляться. Ехать далеко, а у меня встреча с заведующим кафедрой».",
    );
    expect(values[0].editedSegments[1].text).toBe(
      "«О, да! — закричал Джонни. — Это моя жена! Это девушка, на которой я женился!»",
    );
    // A reply that was already correct is left exactly as it is.
    expect(values[0].editedSegments[2].text).toBe("«Она бесполезна, Кайра», — сказал он.");
    expect(buildConsistencyReport(values).documents[0].quotes.balanced).toBe(true);
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
      { source: "Angell", canonical: "Энджелл", variants: ["Анджелл"] },
      { source: "NotPresent", canonical: "Канон", variants: ["Профессор"] },
    ]);

    expect(applied).toBe(1);
    expect(values[0].editedSegments[0].text).toContain("Профессор Энджелл");
    expect(values[0].editedSegments[0].text).not.toContain("Канон");
  });

  it("never lets a decision replace the space around a name", () => {
    // The resolver returned «Терман » — its own canonical with a trailing space — among the
    // variants to replace with «Терман», and the finished book said «Джеки Термандонёсся».
    const values: ConsistencyDocument[] = [
      {
        id: "padded",
        sourceSegments: [sourceSegment("padded:0", "Jackie Therman’s sultry voice carried.")],
        editedSegments: [
          { id: "padded:0", text: "Соблазнительный голос Джеки Терман донёсся сквозь стекло." },
        ],
      },
    ];

    const applied = applyConsistencyDecisions(values, [
      { source: "Therman", canonical: "Терман", variants: ["Терман ", "Терман", "Тэрман"] },
    ]);

    expect(values[0].editedSegments[0].text).toContain("Джеки Терман донёсся");
    expect(values[0].editedSegments[0].text).not.toContain("Термандонёсся");
    expect(applied).toBe(0);
  });

  it("never lets resolver decisions rename an entity", () => {
    // Every decision here is one the resolver actually returned for the reference book.
    const values: ConsistencyDocument[] = [
      {
        id: "rename",
        sourceSegments: [
          sourceSegment("rename:0", "Kyra crossed the room. Kyra Damon said nothing."),
          sourceSegment("rename:1", "“Not now, Ky,” Kyra said to Johnny."),
        ],
        editedSegments: [
          { id: "rename:0", text: "Кайра прошла по комнате. Кайра Дэймон промолчала." },
          { id: "rename:1", text: "«Не сейчас, Кай», — сказала Кира Джонни." },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        { source: "Kyra", canonical: "Кира", variants: ["Кайра", "Кира Дэймон"] },
        { source: "Kyra Damon", canonical: "Кира Дэймон", variants: ["Кайра Дэймон", "Кайра"] },
        { source: "Ky", canonical: "Кай", variants: ["Кира"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    // Кайра → Кира Дэймон → Кира → Кай renamed the protagonist in all 579 of her mentions.
    expect(text).not.toContain("Кай ");
    expect(text).toContain("Кира прошла");
    // The surname is neither dropped from the full name nor added to the bare one.
    expect(text).toContain("Кира Дэймон промолчала");
    expect(text).toContain("сказала Кира Джонни");
    // The nickname keeps its own rendering.
    expect(text).toContain("«Не сейчас, Кай»");
  });

  it("never lets resolver decisions re-inflect an entity", () => {
    // Every decision here is one the resolver returned for job be8d6406, and every one of
    // them reached the shipped EPUB: «Гренландия дьявольской таблички», «Кап. Коллинз»,
    // «данных о КУЛЬТ КТУЛХУ», «разрешение от Архивный фонд».
    const values: ConsistencyDocument[] = [
      {
        id: "inflect",
        sourceSegments: [
          sourceSegment("inflect:0", "the Greenland tablet. Capt. Collins refused."),
          sourceSegment(
            "inflect:1",
            "data on the Cthulhu Cult, permission from the Archive Foundation",
          ),
          sourceSegment("inflect:2", "the schooner Emma sailed"),
        ],
        editedSegments: [
          { id: "inflect:0", text: "гренландской таблички. Капитан Коллинз отказался." },
          {
            id: "inflect:1",
            text: "данных о Культе Ктулху, разрешение от Литературного архивного фонда",
          },
          { id: "inflect:2", text: "шхуна Эмма отплыла" },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        { source: "Greenland", canonical: "Гренландия", variants: ["гренландской"] },
        { source: "Capt", canonical: "Кап.", variants: ["Капитан"] },
        { source: "CTHULHU CULT", canonical: "КУЛЬТ КТУЛХУ", variants: ["Культе Ктулху"] },
        {
          source: "Archive Foundation",
          canonical: "Архивный фонд",
          variants: ["Литературного архивного фонда"],
        },
        { source: "Emma", canonical: "«Эмма»", variants: ["Эмма"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    // An adjective is not a declension of its noun, and a word is not its abbreviation.
    expect(text).toContain("гренландской таблички");
    expect(text).toContain("Капитан Коллинз");
    // A phrase in the prepositional case is not the heading it was taken from.
    expect(text).toContain("данных о Культе Ктулху");
    expect(text).toContain("от Литературного архивного фонда");
    // Adding the marks around a title is still a respelling, and still applies.
    expect(text).toContain("шхуна «Эмма» отплыла");
  });

  it("never lets a decision drop the marks around a variant", () => {
    // Every decision here is one the resolver returned for job 4c3bcb2a, and every one of them
    // reached the shipped EPUB: fifteen lines of dialogue lost their opening guillemet, a car
    // was unquoted, and навахо-гобелену became one word.
    const values: ConsistencyDocument[] = [
      {
        id: "marks",
        sourceSegments: [
          sourceSegment("marks:0", "“Uh-uh, this is sweet,” Kyra agreed. “Real sweet.”"),
          sourceSegment("marks:1", "He drove the Durango past the Navajo rug."),
        ],
        editedSegments: [
          { id: "marks:0", text: "«Ага, мило», — согласилась Кира. «Очень мило»." },
          { id: "marks:1", text: "Он проехал на «Дуранго» мимо навахо-гобелену." },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        { source: "Uh-uh", canonical: "Ага", variants: ["«Ага", "Ага,", "Ага."] },
        { source: "Durango", canonical: "Дуранго", variants: ["«Дуранго»"] },
        { source: "Navajo", canonical: "навахо", variants: ["навахо-"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(text).toContain("«Ага, мило»");
    expect(text).toContain("на «Дуранго» мимо");
    expect(text).toContain("навахо-гобелену");
  });

  it("carries an accepted decision to declined forms and leaves the canonical's own alone", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "carry",
        sourceSegments: [
          sourceSegment("carry:0", "Kyra waited. They followed Kyra past Kirill and Kirov."),
          sourceSegment("carry:1", "Leticia knew. He gave it to Leticia."),
        ],
        editedSegments: [
          { id: "carry:0", text: "Кайра ждала. Пошли за Кайрой мимо Кирилла и Кирова к Кайре." },
          { id: "carry:1", text: "Летиция знала. Он отдал это Летиции." },
        ],
      },
    ];

    applyConsistencyDecisions(
      values,
      [
        { source: "Kyra", canonical: "Кира", variants: ["Кайра"] },
        // The resolver routinely offers the canonical's own declensions as variants.
        { source: "Leticia", canonical: "Летиция", variants: ["Летиции"] },
      ],
      targetLanguageProfile("ru").nameEndings,
    );
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(text).toContain("Кира ждала");
    expect(text).toContain("за Кирой");
    expect(text).toContain("к Кире");
    expect(text).toContain("Кирилла и Кирова");
    // Летиции is Летиция in the genitive, not a competing spelling of it.
    expect(text).toContain("отдал это Летиции");
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

    expect(first.entries).toEqual([
      expect.objectContaining({ source: "Vigilant", target: "«Виджилент»", enabled: true }),
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
    expect(registry.entries.map((entry) => entry.source).sort()).toEqual(["Angell", "Vigilant"]);
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
              text: JSON.stringify([
                { source: "Vigilant", target: "«Виджилент»", category: "ship" },
              ]),
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
      expect.objectContaining({ source: "Vigilant", target: "«Виджилент»", enabled: true }),
    ]);
  });

  it("keeps a settled canonical when new entities appear alongside it", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-stable-`);
    roots.push(root);
    const asked: string[][] = [];
    let answer = "Кайра";
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
                  target: source === "Kyra" ? answer : source,
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
        sourceSegments: ["Kyra", ...extra].flatMap((name, index) => [
          sourceSegment(`book:${index * 2}`, `${name} arrived at dawn.`),
          sourceSegment(`book:${index * 2 + 1}`, `Later ${name} left again.`),
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
    answer = "Кира";
    const second = await resolveEntityRegistry(
      provider,
      { ...profile, model: "another-model" },
      ...languages,
      book(["Raymondo"]),
      root,
    );

    expect(first.entries[0]).toMatchObject({ source: "Kyra", target: "Кайра" });
    // Kyra was settled; only the new entity is asked about, so her rendering cannot flip.
    expect(asked).toEqual([["Kyra"], ["Raymondo"]]);
    expect(second.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "Kyra", target: "Кайра" }),
        expect.objectContaining({ source: "Raymondo" }),
      ]),
    );
  });

  it("builds the entity registry in chunks and keeps the chunks that succeeded", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-entity-registry-chunks-`);
    roots.push(root);
    const names = ["Kyra", "Leticia", "Damon", "Raymondo"];
    const provider: LanguageModelProvider = {
      async complete(request) {
        const payload = JSON.parse(request.segments[0].text);
        // Every request naming Damon times out, exactly like the production run — so
        // halving the chunk cannot rescue it and it is reported rather than retried away.
        if (payload.entities.some((entity: { source: string }) => entity.source === "Damon"))
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
    expect(registry.failedChunks).toEqual([{ chunk: "1.1", error: "Provider request timed out" }]);
    // Neither the other chunk's entries nor the half that answered are lost with it.
    expect(registry.entries.map((entry) => entry.source).sort()).toEqual([
      "Kyra",
      "Leticia",
      "Raymondo",
    ]);
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

  it("extracts a multi-word name as one entity instead of its separate words", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "phrases",
        sourceSegments: [
          sourceSegment(
            "phrases:0",
            "He met Leticia Dreams the Truth Hardin at the Little Chapel of the Stars.",
          ),
          sourceSegment(
            "phrases:1",
            "Leticia Dreams the Truth Hardin drove a Dodge Durango. Kyra waited.",
          ),
          sourceSegment("phrases:2", "Leticia Dreams the Truth Hardin’s truck was gone."),
          sourceSegment("phrases:3", "Then Kyra left the Little Chapel of the Stars alone."),
        ],
        editedSegments: [],
      },
    ];

    const sources = extractRepeatedSourceEntities(values).map((entity) => entity.source);

    expect(sources).toContain("Leticia Dreams the Truth Hardin");
    expect(sources).toContain("Little Chapel of the Stars");
    // A sentence opening is not part of the name, and the possessive is the same entity.
    expect(sources).not.toContain("Then Kyra");
    expect(sources).not.toContain("Leticia Dreams the Truth Hardin’s");
    // A run must not cross a sentence boundary: "Durango. Kyra" is two entities.
    expect(sources).not.toContain("Durango Kyra");
    expect(
      extractRepeatedSourceEntities(values).find(
        (entity) => entity.source === "Leticia Dreams the Truth Hardin",
      )?.occurrences,
    ).toBe(3);
  });

  it("strips a possessive or a contraction that a full stop hid behind", () => {
    // The registry's clitic strip was anchored to the end of the candidate, so "Corvus’s."
    // — ending a sentence — kept its possessive and entered the registry as its own entity.
    // In production that put the book's central figure in as the possessive "Crow’s",
    // resolved to a common noun, and the audit then cited it against correct text.
    const values = [
      {
        id: "clitics",
        sourceSegments: [
          sourceSegment("clitics:0", "Kyra feared Corvus. She had seen Corvus’s."),
          sourceSegment("clitics:1", "Corvus’s. Kyra ran. I’m sure they’ve gone."),
          sourceSegment("clitics:2", "Corvus waited, and I’m certain they’ve waited too."),
          sourceSegment("clitics:3", "Didn’t she run? Shouldn’t she? Didn’t Corvus wait?"),
        ],
        editedSegments: [],
      },
    ];

    const sources = extractRepeatedSourceEntities(values).map((entity) => entity.source);

    expect(sources).toContain("Corvus");
    expect(sources).not.toContain("Corvus’s");
    expect(sources).not.toContain("I’m");
    expect(sources).not.toContain("They’ve");
    // n’t belongs to the verb: stripping it leaves "Didn", which no filter recognizes.
    expect(sources).not.toContain("Didn");
    expect(sources).not.toContain("Shouldn");
  });

  it("keeps a name the book also spells as a common noun", () => {
    // "The Crow" ran 326 mid-sentence capitals against 3 lowercase birds and was still
    // dropped as a common word, so the book's central figure had no canonical rendering and
    // every stage guessed one — the audit ended up citing a possessive against correct text.
    const named = (times: number, text: string) =>
      Array.from({ length: times }, (_, index) => sourceSegment(`crow:${text}${index}`, text));
    const values: ConsistencyDocument[] = [
      {
        id: "crow",
        sourceSegments: [
          ...named(8, "Kyra felt the Crow watching her from the wire."),
          ...named(1, "A crow settled on the wire and said nothing."),
          // Capitalized often enough to clear the floor, nowhere near often enough to clear
          // the margin: an ordinary noun that a few sentences happen to dress up.
          ...named(6, "Kyra saw the Truth in it and looked away."),
          ...named(12, "The truth was thin, and the truth was cold."),
        ],
        editedSegments: [],
      },
    ];

    const sources = extractRepeatedSourceEntities(values).map((entity) => entity.source);

    expect(sources).toContain("Crow");
    expect(sources).not.toContain("Truth");
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

    const provider: LanguageModelProvider = {
      async complete(request) {
        const payload = JSON.parse(request.segments[0].text);
        // Every request naming Damon times out, exactly like the production run, so halving
        // the chunk cannot rescue it either.
        if (
          payload.report.entityEvidence.some(
            (entity: { source: string }) => entity.source === "Damon",
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
    // Five entities in chunks of two. The chunk holding Damon failed, but halving it saved
    // the entity it was paired with, so only Damon itself is left unanswered.
    expect(Object.keys(cache.value.entities)).toHaveLength(4);
  });

  it("aligns name variants from the glossary when the resolver is unavailable", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "fallback",
        sourceSegments: [
          sourceSegment("fallback:0", "Kyra waited. Kyra waited. Kyra left."),
          sourceSegment("fallback:1", "Leticia called Kyra. Leticia said nothing."),
          sourceSegment("fallback:2", "Kyra had a plan."),
        ],
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
    // Without the Russian ending rules, inflected forms stay untouched.
    expect(text).toContain("Киры");
  });

  it("corrects the stem of a declined variant and keeps its case ending", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "inflected",
        // Both renderings are in use throughout, which is what an unresolved run looks like.
        sourceSegments: [
          sourceSegment("inflected:0", "Kyra waited. Kyra left. Kyra had a plan."),
          sourceSegment("inflected:1", "He told Kyra about Kirill and the town of Kirov."),
          sourceSegment("inflected:2", "Kyra saw it. They followed Kyra out of Kyra's house."),
          sourceSegment("inflected:3", "He looked at Leticia and Leticia was afraid."),
          sourceSegment("inflected:4", "Leticia knew. He gave it to Leticia and left Leticia."),
          sourceSegment("inflected:5", "Damon hit Church, and Church said nothing to Damon."),
          sourceSegment("inflected:6", "Damon watched Church. Church nodded to Damon."),
        ],
        editedSegments: [
          { id: "inflected:0", text: "Кайра ждала. Кира ушла. У Киры был план." },
          { id: "inflected:1", text: "Он рассказал Кире о Кирилле и о городе Кирове." },
          { id: "inflected:2", text: "Кайра видела. Пошли за Кайрой из дома Кайры к Кайре." },
          { id: "inflected:3", text: "Он посмотрел на Летисию, и Летисии стало страшно." },
          { id: "inflected:4", text: "Летиция знала. Отдал Летиции и оставил Летицию." },
          { id: "inflected:5", text: "Дэймон ударил Черча, и Черч ничего не сказал Дэймону." },
          { id: "inflected:6", text: "Деймон смотрел на Чёрча. Чёрч кивнул Деймону." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Kyra", target: "Кайра", category: "person", enabled: true },
      { id: "g2", source: "Leticia", target: "Летиция", category: "person", enabled: true },
      { id: "g3", source: "Damon", target: "Деймон", category: "person", enabled: true },
      { id: "g4", source: "Church", target: "Чёрч", category: "person", enabled: true },
    ];

    alignGlossaryVariants(values, glossary, targetLanguageProfile("ru").nameEndings);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(text).toContain("Кайры");
    expect(text).toContain("Кайре");
    expect(text).not.toMatch(/Кир[аыеу]\b/u);
    // The whole point: a declined variant keeps its case, it is not flattened to the
    // nominative canonical the way "Он ударил Чёрч по лицу" used to be.
    expect(text).toContain("на Летицию");
    expect(text).toContain("Летиции стало");
    expect(text).toContain("ударил Чёрча");
    expect(text).toContain("сказал Деймону");
    expect(text).not.toMatch(/Летис|Дэймон|Черч/u);
    // A different name and a place that merely share the prefix must survive.
    expect(text).toContain("Кирилле");
    expect(text).toContain("Кирове");
  });

  it("never rewrites an ordinary word or an unrelated name that resembles a glossary entry", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "lookalikes",
        sourceSegments: [
          sourceSegment("lookalikes:0", "Leti watched. Children were playing outside."),
          sourceSegment("lookalikes:1", "Cody nodded. Hordi walked into the bar."),
          sourceSegment("lookalikes:2", "Damon turned. Demon or man, he was coming."),
          sourceSegment("lookalikes:3", "The children ran to the demon."),
        ],
        editedSegments: [
          { id: "lookalikes:0", text: "Лети смотрела. Дети играли во дворе." },
          { id: "lookalikes:1", text: "Коди кивнул. Хорди зашёл в бар." },
          { id: "lookalikes:2", text: "Деймон обернулся. Демон или человек, он шёл." },
          { id: "lookalikes:3", text: "Дети побежали к демону." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Leti", target: "Лети", category: "person", enabled: true },
      { id: "g2", source: "Cody", target: "Коди", category: "person", enabled: true },
      { id: "g3", source: "Damon", target: "Деймон", category: "person", enabled: true },
    ];

    const result = alignGlossaryVariants(values, glossary, targetLanguageProfile("ru").nameEndings);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(result.replacements).toEqual([]);
    expect(text).toContain("Дети играли");
    expect(text).toContain("Хорди зашёл");
    expect(text).toContain("Демон или человек");
  });

  it("leaves a rare bystander name and a canonical the book never used alone", () => {
    const mentions = Array.from({ length: 60 }, (_, index) => index);
    const values: ConsistencyDocument[] = [
      {
        id: "rare",
        sourceSegments: [
          ...mentions.map((index) => sourceSegment(`rare:${index}`, `Johnny spoke again.`)),
          sourceSegment("rare:60", "Johnny looked at Denny."),
          sourceSegment("rare:61", "The Westinghouse hummed in the corner."),
        ],
        editedSegments: [
          ...mentions.map((index) => ({ id: `rare:${index}`, text: "Джонни снова заговорил." })),
          { id: "rare:60", text: "Джонни посмотрел на Денни." },
          { id: "rare:61", text: "Вестингауз гудел в углу." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Johnny", target: "Джонни", category: "person", enabled: true },
      // The registry misspelled this one; a canonical the book never uses is not authority.
      { id: "g2", source: "Westinghouse", target: "Вестнигауз", category: "other", enabled: true },
    ];

    const result = alignGlossaryVariants(values, glossary, targetLanguageProfile("ru").nameEndings);
    const text = values[0].editedSegments.map((segment) => segment.text).join(" ");

    expect(result.replacements).toEqual([]);
    expect(text).toContain("на Денни");
    expect(text).toContain("Вестингауз гудел");
  });

  it("measures how often the models actually used the glossary rendering", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "adherence",
        sourceSegments: [
          sourceSegment("adherence:0", "Kyra waited."),
          sourceSegment("adherence:1", "Kyra left."),
          sourceSegment("adherence:2", "Kyra had a plan."),
          sourceSegment("adherence:3", "Leticia waited for Kyra."),
        ],
        editedSegments: [
          { id: "adherence:0", text: "Кира ждала." },
          { id: "adherence:1", text: "Кира ушла." },
          { id: "adherence:2", text: "У Кайры был план." },
          { id: "adherence:3", text: "Летиция ждала Киру." },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "Kyra", target: "Кайра", category: "person", enabled: true },
      { id: "g2", source: "Leticia", target: "Летиция", category: "person", enabled: true },
    ];

    const adherence = measureGlossaryAdherence(values, glossary);

    expect(adherence).toContainEqual({
      source: "Kyra",
      target: "Кайра",
      blocks: 4,
      blocksUsingTarget: 1,
    });
    expect(glossaryAdherenceWarnings(adherence).map((entry) => entry.source)).toEqual(["Kyra"]);
  });

  it("counts a declined, quoted or multi-word glossary target as adherence", () => {
    // Every entry here was reported as ignored by job efe7bb1b, and every block below obeys
    // it: the target is simply never written in the nominative.
    const values: ConsistencyDocument[] = [
      {
        id: "inflected",
        sourceSegments: [
          sourceSegment("inflected:0", "in April, in the United States"),
          sourceSegment("inflected:1", "the Cyclopean masonry of New Orleans"),
          sourceSegment("inflected:2", "the schooner Emma"),
        ],
        editedSegments: [
          { id: "inflected:0", text: "в апреле, в Соединённых Штатах" },
          { id: "inflected:1", text: "циклопической кладки Нового Орлеана" },
          { id: "inflected:2", text: "шхуны «Эммы»" },
        ],
      },
    ];
    const glossary = [
      { id: "g1", source: "April", target: "апрель", category: "term", enabled: true },
      {
        id: "g2",
        source: "United States",
        target: "Соединённые Штаты",
        category: "place",
        enabled: true,
      },
      { id: "g3", source: "Cyclopean", target: "циклопический", category: "term", enabled: true },
      { id: "g4", source: "New Orleans", target: "Новый Орлеан", category: "place", enabled: true },
      { id: "g5", source: "Emma", target: "«Эмма»", category: "ship", enabled: true },
    ];

    const adherence = measureGlossaryAdherence(values, glossary);

    for (const entry of adherence) expect(entry).toMatchObject({ blocksUsingTarget: entry.blocks });
    expect(glossaryAdherenceWarnings(adherence)).toEqual([]);
  });

  it("makes the NCX navMap the authority for a table-of-contents label", () => {
    const values: ConsistencyDocument[] = [
      {
        id: "ncx",
        sourceSegments: [sourceSegment("ncx:0", "Part 2. In the Desert")],
        editedSegments: [{ id: "ncx:0", text: "Часть 2. В пустыне" }],
      },
      {
        id: "nav",
        sourceSegments: [sourceSegment("nav:0", "Part 2. In the Desert")],
        editedSegments: [{ id: "nav:0", text: "Глава вторая. Среди песков" }],
      },
      {
        id: "chapter",
        sourceSegments: [
          sourceSegment("chapter:0", " Part 2.  In the Desert "),
          sourceSegment("chapter:1", "The wind never stopped."),
        ],
        editedSegments: [
          { id: "chapter:0", text: " В пустыне " },
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
    expect(values[1].editedSegments[0].text).toBe("Часть 2. В пустыне");
    // Surrounding whitespace of the original text node is preserved.
    expect(values[2].editedSegments[0].text).toBe(" Часть 2. В пустыне ");
    // Prose that never appears in a navigation document is left alone.
    expect(values[2].editedSegments[1].text).toBe("Ветер не стихал.");
  });
});
