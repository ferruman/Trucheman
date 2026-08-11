import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../../src/server/providers/fake-provider.js";
import { ProviderError, type LanguageModelProvider } from "../../src/server/providers/provider.js";
import { runTwoPass } from "../../src/server/jobs/job-runner.js";

const languages = {
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
};

const segment = {
  id: "chapter-1:0",
  text: "Hello",
  sourceHash: "",
  locator: [],
  leading: "",
  trailing: "",
};

describe("two-pass pipeline", () => {
  it("persists drafts before edits in chapter order", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-translator-`);
    const provider = new FakeProvider();
    const profile = { name: "fake", endpoint: "local", model: "fake" };
    await runTwoPass([{ id: "batch-1", documentId: "chapter-1", segments: [segment] }], provider, {
      root,
      translationProfile: profile,
      editingProfile: profile,
      ...languages,
    });
    expect(provider.requests.map((request) => request.mode)).toEqual(["translation", "editing"]);
    expect(provider.requests[0]).toMatchObject(languages);
    expect((await readFile(`${root}/drafts.ndjson`, "utf8")).length).toBeGreaterThan(0);
  });

  it("sends each batch the card of its own chapter, and none to a chapter without one", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-chapter-cards-`);
    const provider = new FakeProvider();
    const profile = { name: "fake", endpoint: "local", model: "fake" };
    await runTwoPass(
      [
        { id: "batch-1", documentId: "chapter-1", segments: [segment] },
        { id: "batch-2", documentId: "chapter-2", segments: [{ ...segment, id: "chapter-2:0" }] },
      ],
      provider,
      {
        root,
        translationProfile: profile,
        editingProfile: profile,
        ...languages,
        instructions: "Prefer concise dialogue",
        chapterCards: new Map([["chapter-1", "- Kyra: female, singular"]]),
      },
    );
    const instructions = provider.requests
      .filter((request) => request.mode === "translation")
      .map((request) => request.instructions);
    expect(instructions).toEqual([
      "Prefer concise dialogue\n\n- Kyra: female, singular",
      "Prefer concise dialogue",
    ]);
  });

  it("reports the active model stage before a provider failure", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-stage-failure-`);
    const stages: string[] = [];
    const provider: LanguageModelProvider = {
      async complete(request) {
        if (request.mode === "editing") {
          throw new ProviderError("configuration", "Editor failed");
        }
        return {
          segments: request.segments.map((item) => ({ id: item.id, text: "Черновик" })),
          finishReason: "stop",
        };
      },
    };
    const profile = { name: "fake", endpoint: "local", model: "fake" };

    await expect(
      runTwoPass([{ id: "batch-1", documentId: "chapter-1", segments: [segment] }], provider, {
        root,
        translationProfile: profile,
        editingProfile: profile,
        ...languages,
        onStage: (stage) => {
          stages.push(stage);
        },
      }),
    ).rejects.toThrow("Editor failed");

    expect(stages).toEqual(["translation", "editing"]);
  });

  it("reuses only checkpoints produced from the same inputs and provider profile", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-resume-`);
    const provider = new FakeProvider();
    const profile = { name: "fake", endpoint: "local", model: "v1" };
    const batches = [{ id: "chapter-1-batch-1", documentId: "chapter-1", segments: [segment] }];
    const options = {
      root,
      translationProfile: profile,
      editingProfile: profile,
      instructions: "Keep names",
      ...languages,
    };
    await runTwoPass(batches, provider, options);
    await runTwoPass(batches, provider, options);
    expect(provider.requests).toHaveLength(2);
    const changed = { ...profile, model: "v2" };
    await runTwoPass(batches, provider, {
      ...options,
      translationProfile: changed,
      editingProfile: changed,
    });
    expect(provider.requests).toHaveLength(4);
  });

  it("recovers compatible batch checkpoints when explicitly resuming failed work", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-compatible-resume-`);
    const provider = new FakeProvider();
    const profile = { name: "fake", endpoint: "local", model: "v1" };
    const batches = [{ id: "chapter-1-batch-1", documentId: "chapter-1", segments: [segment] }];
    const options = {
      root,
      translationProfile: profile,
      editingProfile: profile,
      glossary: [{ source: "name", target: "имя" }],
      ...languages,
    };

    await runTwoPass(batches, provider, options);
    await runTwoPass(batches, provider, {
      ...options,
      translationProfile: { ...profile, model: "v2" },
      editingProfile: { ...profile, model: "v2" },
      glossary: [{ source: "name", target: "название" }],
      recoverCompatibleCheckpoints: true,
    });

    expect(provider.requests).toHaveLength(2);
  });

  // 274 batches means ~1000 fsynced journal appends; the default 5s timeout is too tight
  // when this file runs alongside the rest of the suite.
  it(
    "resumes a large failed run without re-paying for its completed batches",
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(`${tmpdir()}/book-large-resume-`);
      const profile = { name: "fake", endpoint: "local", model: "v1" };
      const batches = Array.from({ length: 274 }, (_, index) => ({
        id: `document-1-batch-${index + 1}`,
        documentId: "document-1",
        segments: [{ ...segment, id: `document-1:${index}`, text: `Sentence ${index}.` }],
      }));
      const options = {
        root,
        translationProfile: profile,
        editingProfile: profile,
        ...languages,
      };

      // A run that dies after 253 batches.
      const first = new FakeProvider();
      await expect(
        runTwoPass(batches, first, {
          ...options,
          onStage: (stage, batch) => {
            if (stage === "translation" && batch.id === "document-1-batch-254")
              throw new ProviderError("temporary", "Crashed");
          },
        }),
      ).rejects.toThrow("Crashed");
      const drafted = new Set(
        (await readFile(`${root}/drafts.ndjson`, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).batchId),
      );
      expect(drafted.size).toBe(253);

      // The retry re-reads those checkpoints and only calls the model for what is left.
      const second = new FakeProvider();
      const cached: Record<string, number> = { translation: 0, editing: 0 };
      const result = await runTwoPass(batches, second, {
        ...options,
        onProgress: (stage, _batch, isCached) => {
          if (isCached) cached[stage]++;
        },
      });

      expect(cached.translation).toBe(253);
      expect(result.cachedCheckpoints.translation).toBe(253);
      expect(second.requests.filter((request) => request.mode === "translation")).toHaveLength(
        274 - 253,
      );
      expect(second.requests.filter((request) => request.mode === "editing")).toHaveLength(
        274 - cached.editing,
      );
    },
  );

  it("runs batches concurrently without tearing the journals", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-concurrent-`);
    const profile = { name: "fake", endpoint: "local", model: "fake" };
    // Long text: a torn append is only possible once a record no longer lands in one write.
    const filler = "Sentence text. ".repeat(4000);
    const batches = Array.from({ length: 12 }, (_, index) => ({
      id: `document-1-batch-${index + 1}`,
      documentId: "document-1",
      segments: [{ ...segment, id: `document-1:${index}`, text: `${index} ${filler}` }],
    }));
    let inFlight = 0,
      peak = 0;
    const provider: LanguageModelProvider = {
      async complete(request) {
        peak = Math.max(peak, ++inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            segments: request.segments.map((item) => ({ id: item.id, text: `перевод ${item.id}` })),
            finishReason: "stop",
          };
        } finally {
          inFlight--;
        }
      },
    };

    const result = await runTwoPass(batches, provider, {
      root,
      translationProfile: profile,
      editingProfile: profile,
      concurrency: 4,
      ...languages,
    });

    expect(peak).toBeGreaterThan(1);
    expect(result.edits.size).toBe(batches.length);
    // readJournal stops at the first unparseable line, so a torn record shows up as a short read.
    for (const journal of ["drafts", "edits"]) {
      const lines = (await readFile(`${root}/${journal}.ndjson`, "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(lines.map((line) => JSON.parse(line).batchId).sort()).toEqual(
        batches.map((batch) => batch.id).sort(),
      );
    }
  });

  it("stops claiming batches once one of them fails", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-concurrent-failure-`);
    const profile = { name: "fake", endpoint: "local", model: "fake" };
    const batches = Array.from({ length: 40 }, (_, index) => ({
      id: `document-1-batch-${index + 1}`,
      documentId: "document-1",
      segments: [{ ...segment, id: `document-1:${index}`, text: `Sentence ${index}.` }],
    }));
    let calls = 0;
    const provider: LanguageModelProvider = {
      async complete(request) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (++calls === 5) throw new ProviderError("configuration", "Key rejected");
        return {
          segments: request.segments.map((item) => ({ id: item.id, text: "перевод" })),
          finishReason: "stop",
        };
      },
    };

    await expect(
      runTwoPass(batches, provider, {
        root,
        translationProfile: profile,
        editingProfile: profile,
        concurrency: 4,
        ...languages,
      }),
    ).rejects.toThrow("Key rejected");

    // The workers already in flight finish their batch; nobody picks up the remaining 30-odd.
    expect(calls).toBeLessThan(batches.length);
  });

  it("reverts a repair the optional second audit still calls broken", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-post-repair-audit-`);
    const audits: number[] = [];
    let auditRound = 0;
    const issue = (span: string, severity: "medium" | "high") => ({
      span,
      type: "unnatural_language" as const,
      severity,
      reason: "reason",
    });
    const provider: LanguageModelProvider = {
      async complete(request) {
        if (request.mode === "audit") {
          auditRound++;
          audits.push(request.segments.length);
          return {
            segments: request.segments.map((item) => ({
              id: item.id,
              text: "",
              // First pass flags the block; the second pass says the repair is still wrong.
              issues: [issue(auditRound === 1 ? "Черновик" : "Починено", "high")],
            })),
            finishReason: "stop",
          };
        }
        return {
          segments: request.segments.map((item) => ({
            id: item.id,
            text: request.mode === "repair" ? "Починено" : "Черновик",
          })),
          finishReason: "stop",
        };
      },
    };
    const profile = { name: "fake", endpoint: "local", model: "fake" };
    const batches = [{ id: "chapter-1-batch-1", documentId: "chapter-1", segments: [segment] }];
    const options = {
      root,
      translationProfile: profile,
      editingProfile: profile,
      qualityMode: "high" as const,
      ...languages,
    };

    const without = await runTwoPass(batches, provider, options);
    expect(without.edits.get("chapter-1-batch-1")?.[0].text).toBe("Починено");
    expect(audits).toEqual([1]); // the second pass never ran

    auditRound = 0;
    audits.length = 0;
    const withAudit = await runTwoPass(batches, provider, {
      ...options,
      root: await mkdtemp(`${tmpdir()}/book-post-repair-audit-on-`),
      postRepairAudit: true,
    });

    expect(audits).toEqual([1, 1]); // only the block the repair changed is re-audited
    expect(withAudit.edits.get("chapter-1-batch-1")?.[0].text).toBe("Черновик");
  });

  it("invalidates only the editing checkpoint when its prompt version changes", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-prompt-checkpoint-`);
    const provider = new FakeProvider();
    const profile = { name: "fake", endpoint: "local", model: "v1" };
    const batches = [{ id: "chapter-1-batch-1", documentId: "chapter-1", segments: [segment] }];
    const options = {
      root,
      translationProfile: profile,
      editingProfile: profile,
      ...languages,
    };

    await runTwoPass(batches, provider, options);
    await runTwoPass(batches, provider, {
      ...options,
      editingProfile: { ...profile, promptVersion: "literary-v3.2.1" },
    });

    expect(provider.requests.map((request) => request.mode)).toEqual([
      "translation",
      "editing",
      "editing",
    ]);
    expect(provider.requests.at(-1)?.promptVersion).toBe("literary-v3.2.1");
  });

  it("reuses content checkpoints after batch identifiers change", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-checkpoint-migration-`);
    const provider = new FakeProvider();
    const profile = { name: "fake", endpoint: "local", model: "v1" };
    const options = {
      root,
      translationProfile: profile,
      editingProfile: profile,
      ...languages,
    };
    await runTwoPass(
      [{ id: "batch-1", documentId: "chapter-1", segments: [segment] }],
      provider,
      options,
    );
    const result = await runTwoPass(
      [{ id: "chapter-1-batch-1", documentId: "chapter-1", segments: [segment] }],
      provider,
      options,
    );
    expect(provider.requests).toHaveLength(2);
    expect(result.edits.get("chapter-1-batch-1")?.[0]?.text).toBe("[translated] Hello");
  });

  it("audits every edited segment and repairs only flagged segments in high-quality mode", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-selective-quality-`);
    const provider: LanguageModelProvider & {
      requests: Array<{ mode: string; model: string }>;
    } = {
      requests: [],
      async complete(request) {
        this.requests.push({ mode: request.mode, model: request.profile.model });
        return {
          segments: request.segments.map((input) => {
            if (request.mode === "translation") {
              return { id: input.id, text: "Черновик" };
            }
            if (request.mode === "editing") {
              return { id: input.id, text: input.id.endsWith(":0") ? "Плохая калька" : "Хорошо" };
            }
            if (request.mode === "audit") {
              return {
                id: input.id,
                text: input.id.endsWith(":1")
                  ? "truncated audit json"
                  : JSON.stringify({
                      issues: [
                        {
                          span: "Плохая калька",
                          type: "source_language_interference",
                          severity: "medium",
                          reason: "Literal source construction",
                        },
                      ],
                    }),
              };
            }
            return { id: input.id, text: "Исправлено" };
          }),
          finishReason: "stop",
        };
      },
    };
    const profile = { name: "fake", endpoint: "local", model: "fake" };
    const second = { ...segment, id: "chapter-1:1", text: "World" };
    const options = {
      root,
      translationProfile: profile,
      editingProfile: profile,
      criticProfile: { ...profile, name: "critic", model: "critic-model" },
      qualityMode: "high" as const,
      ...languages,
    };
    const batches = [{ id: "batch-quality", documentId: "chapter-1", segments: [segment, second] }];

    const result = await runTwoPass(batches, provider, options);
    await runTwoPass(batches, provider, options);

    expect(provider.requests).toEqual([
      { mode: "translation", model: "fake" },
      { mode: "editing", model: "fake" },
      { mode: "audit", model: "critic-model" },
      { mode: "repair", model: "fake" },
    ]);
    expect(result.edits.get("batch-quality")).toEqual([
      { id: "chapter-1:0", text: "Исправлено" },
      { id: "chapter-1:1", text: "Хорошо" },
    ]);
    const report = JSON.parse(await readFile(`${root}/quality-report.json`, "utf8"));
    expect(report).toMatchObject({
      auditedSegments: 2,
      flaggedSegments: 1,
      repairedSegments: 1,
      auditErrorSegments: 1,
      rejectedIssues: 0,
    });
  });
});
