import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../../src/server/providers/fake-provider.js";
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
});
