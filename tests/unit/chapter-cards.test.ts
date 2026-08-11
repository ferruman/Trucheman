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
          { name: "Kyra", gender: "female", number: "singular" },
          { name: "Nobody", gender: "  " },
        ],
        address: [{ from: "Kyra", to: "Marlow", register: "formal" }],
        terms: [{ source: "the device", note: "the compass" }],
      }),
    ).toBe(
      [
        "This chapter's established facts. They are binding for every block of this chapter, including blocks that do not name the character themselves:",
        "- Kyra: female, singular",
        "- Kyra addresses Marlow: formal",
        '- recurring term "the device": the compass',
      ].join("\n"),
    );
  });

  it("is empty when the model returned nothing usable", () => {
    expect(formatChapterCard({ characters: [], address: [], terms: [] })).toBe("");
  });

  it("drops a character whose gender the chapter never established", () => {
    // Both cards job efe7bb1b produced. Neither names a character; both were handed to every
    // batch of their chapter as binding facts.
    expect(
      formatChapterCard({
        characters: [
          {
            name: "The Project Gutenberg eBook of The Call of Cthulhu",
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
  const chapter = "Марья Ивановна ждала у окна. «Вы уверены?» — спросил он про «серую башню».";

  it("keeps a fact whose quote is in the chapter and drops one that is not", () => {
    const verified = verifyChapterCard(
      {
        characters: [
          { name: "Марья", gender: "female", evidence: "Марья Ивановна ждала" },
          { name: "Пётр", gender: "male", evidence: "Пётр вошёл в комнату" },
        ],
        address: [{ from: "он", to: "Марья", register: "formal", evidence: '"Вы уверены?"' }],
        terms: [{ source: "серую башню" }, { source: "хрустальный мост" }],
      },
      chapter,
    );
    expect(verified.card.characters.map((character) => character.name)).toEqual(["Марья"]);
    // Quotes and dashes differ between what the model returns and what it read.
    expect(verified.card.address).toHaveLength(1);
    expect(verified.card.terms.map((term) => term.source)).toEqual(["серую башню"]);
    expect(verified.dropped).toBe(2);
  });

  it("drops a fact with no evidence at all rather than trusting it", () => {
    expect(
      verifyChapterCard({ characters: [{ name: "Марья", gender: "female" }] }, chapter),
    ).toMatchObject({ card: { characters: [] }, dropped: 1 });
  });
});

describe("resolveChapterCards", () => {
  it("skips short documents, caches per chapter, and asks once", async () => {
    const root = await mkdtemp(join(tmpdir(), "chapter-cards-"));
    try {
      const provider = new StubProvider({
        characters: [
          { name: "Kyra", gender: "female", evidence: "She waited." },
          // The chapter never mentions him: a card is binding for every block of the chapter,
          // so an invented character would be asserted across all of them.
          { name: "Aldous", gender: "male", evidence: "Aldous drew his sword." },
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
      expect(again.cards.get("document-2")?.characters?.map((c) => c.name)).toEqual(["Kyra"]);
      expect(JSON.parse(await readFile(join(root, "chapter-cards.json"), "utf8")).key).toContain(
        "chapter-cards-v",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
