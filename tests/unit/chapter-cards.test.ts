import { describe, expect, it } from "vitest";
import {
  formatChapterCard,
  resolveChapterCards,
  verifyChapterCard,
} from "../../src/server/jobs/chapter-card-service.js";
import type { ConsistencyDocument } from "../../src/server/jobs/consistency-service.js";
import type {
  LanguageModelProvider,
  ProviderRequest,
  ProviderResponse,
} from "../../src/server/providers/provider.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const languages = {
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
};
const profile = {
  name: "consistency",
  endpoint: "https://example.invalid",
  model: "test",
  apiKey: "key",
  promptVersion: "literary-v3.1",
} as never;

function document(id: string, text: string): ConsistencyDocument {
  return {
    id,
    sourceSegments: [{ id: `${id}#1`, text }] as ConsistencyDocument["sourceSegments"],
    editedSegments: [],
  };
}

class StubProvider implements LanguageModelProvider {
  requests: ProviderRequest[] = [];
  constructor(private readonly card: unknown) {}
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return {
      segments: [{ id: request.segments[0].id, text: JSON.stringify(this.card) }],
      finishReason: "stop",
    };
  }
}

describe("formatChapterCard", () => {
  it("keeps only the facts a single block cannot recover", () => {
    expect(
      formatChapterCard({
        characters: [
          { name: "Alice", gender: "female", number: "singular" },
          { name: "Nobody", gender: "  " },
        ],
        address: [{ from: "Alice", to: "White Rabbit", register: "formal" }],
        terms: [{ source: "little golden key", note: "opens the tiny door" }],
      }),
    ).toBe(
      [
        "This chapter's established facts. They are binding for every block of this chapter, including blocks that do not name the character themselves:",
        "- Alice: female, singular",
        "- Alice addresses White Rabbit: formal",
        '- recurring term "little golden key": opens the tiny door',
      ].join("\n"),
    );
  });

  it("is empty when the model returned nothing usable", () => {
    expect(formatChapterCard({ characters: [], address: [], terms: [] })).toBe("");
  });

  it("drops a character whose gender the chapter never established", () => {
    // Neither candidate names a character, so neither belongs in a binding chapter card.
    expect(
      formatChapterCard({
        characters: [
          {
            name: "Alice’s Adventures in Wonderland",
            gender: "unknown",
            number: "singular",
          },
        ],
        address: [],
        terms: [],
      }),
    ).toBe("");
    expect(
      formatChapterCard({
        characters: [{ name: "не назван", gender: "unknown", number: "singular" }],
        address: [],
        terms: [],
      }),
    ).toBe("");
  });
});

describe("verifyChapterCard", () => {
  const chapter = "Алиса ждала у маленькой двери. «Вы опаздываете?» — спросила она Белого Кролика.";

  it("keeps a fact whose quote is in the chapter and drops one that is not", () => {
    const verified = verifyChapterCard(
      {
        characters: [
          { name: "Алиса", gender: "female", evidence: "Алиса ждала" },
          { name: "Дина", gender: "female", evidence: "Дина сидела у камина" },
        ],
        address: [
          {
            from: "Алиса",
            to: "Белый Кролик",
            register: "formal",
            evidence: '"Вы опаздываете?"',
          },
        ],
        terms: [{ source: "маленькой двери" }, { source: "золотой ключ" }],
      },
      chapter,
    );
    expect(verified.card.characters.map((character) => character.name)).toEqual(["Алиса"]);
    // Quotes and dashes differ between what the model returns and what it read.
    expect(verified.card.address).toHaveLength(1);
    expect(verified.card.terms.map((term) => term.source)).toEqual(["маленькой двери"]);
    expect(verified.dropped).toBe(2);
  });

  it("drops a fact with no evidence at all rather than trusting it", () => {
    expect(
      verifyChapterCard({ characters: [{ name: "Алиса", gender: "female" }] }, chapter),
    ).toMatchObject({ card: { characters: [] }, dropped: 1 });
  });
});

describe("resolveChapterCards", () => {
  it("skips short documents, caches per chapter, and asks once", async () => {
    const root = await mkdtemp(join(tmpdir(), "chapter-cards-"));
    try {
      const provider = new StubProvider({
        characters: [
          { name: "Alice", gender: "female", evidence: "She waited." },
          // The chapter never mentions him: a card is binding for every block of the chapter,
          // so an invented character would be asserted across all of them.
          { name: "White Rabbit", gender: "male", evidence: "The White Rabbit drew his sword." },
        ],
      });
      const documents = [
        document("document-1", "Title page"),
        document("document-2", "She waited. ".repeat(400)),
      ];
      const resolve = () =>
        resolveChapterCards(
          provider,
          profile,
          languages.sourceLanguage,
          languages.targetLanguage,
          documents,
          root,
        );

      const { cards, failed } = await resolve();
      expect([...cards.keys()]).toEqual(["document-2"]);
      expect(failed).toBe(0);
      expect(provider.requests).toHaveLength(1);
      expect(JSON.parse(provider.requests[0].segments[0].text!).task).toBe("chapter_card");

      const again = await resolve();
      expect(provider.requests).toHaveLength(1);
      expect(again.cards.get("document-2")?.characters?.map((c) => c.name)).toEqual(["Alice"]);
      expect(JSON.parse(await readFile(join(root, "chapter-cards.json"), "utf8")).key).toContain(
        "chapter-cards-v",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("trims an over-long list instead of losing the whole card", async () => {
    const root = await mkdtemp(join(tmpdir(), "chapter-cards-cap-"));
    try {
      // An oversized term list must not make the card lose valid characters and address
      // registers as a whole.
      const answer = JSON.stringify({
        characters: [{ name: "Alice", gender: "female", evidence: "She waited." }],
        terms: Array.from({ length: 21 }, () => ({ source: "She waited." })),
      });
      const provider: LanguageModelProvider = {
        async complete(request: ProviderRequest): Promise<ProviderResponse> {
          return {
            segments: [{ id: request.segments[0].id, text: answer }],
            finishReason: "stop",
          };
        },
      };

      const { cards, failed } = await resolveChapterCards(
        provider,
        profile,
        languages.sourceLanguage,
        languages.targetLanguage,
        [document("document-3", "She waited. ".repeat(400))],
        root,
      );

      expect(failed).toBe(0);
      expect(cards.get("document-3")?.characters?.map((character) => character.name)).toEqual([
        "Alice",
      ]);
      expect(cards.get("document-3")?.terms).toHaveLength(20);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("asks a second time when the first answer is not usable JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "chapter-cards-retry-"));
    try {
      // What run 9cfcd03a actually got back: an answer the model finished normally, one
      // closing bracket short. Nothing downstream notices a card that never arrives, and a
      // chapter is one indivisible question, so the only recovery is asking again.
      const answers = [
        '{"characters":[{"name":"Alice","gender":"female","evidence":"She waited."}]}}',
        '{"characters":[{"name":"Alice","gender":"female","evidence":"She waited."}]}',
      ];
      const provider: LanguageModelProvider = {
        async complete(request: ProviderRequest): Promise<ProviderResponse> {
          return {
            segments: [{ id: request.segments[0].id, text: answers.shift() ?? "" }],
            finishReason: "stop",
          };
        },
      };

      const { cards, failed } = await resolveChapterCards(
        provider,
        profile,
        languages.sourceLanguage,
        languages.targetLanguage,
        [document("document-2", "She waited. ".repeat(400))],
        root,
      );

      expect(failed).toBe(0);
      expect(cards.get("document-2")?.characters?.map((character) => character.name)).toEqual([
        "Alice",
      ]);
      expect(answers).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
