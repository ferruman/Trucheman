import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { createApp } from "../../src/server/app.js";
import { chapterMarkdown, chapterXhtml } from "../../src/server/workspace/codicora.js";

const roots: string[] = [];
let savedProvider: string | undefined;
beforeEach(() => {
  savedProvider = process.env.BOOK_TRANSLATOR_PROVIDER;
  process.env.BOOK_TRANSLATOR_PROVIDER = "deterministic";
});
afterEach(async () => {
  if (savedProvider === undefined) delete process.env.BOOK_TRANSLATOR_PROVIDER;
  else process.env.BOOK_TRANSLATOR_PROVIDER = savedProvider;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const chapterOne = `<!-- scene: 4f2e9b1c -->
Ilya walked to the *river* at dawn.

The water was **cold**.
He did not mind.

<!-- scene: 9a0b -->
## Later

In the evening he came back.
`;

async function workspace(withEdited: boolean) {
  const root = await mkdtemp(join(tmpdir(), "codicora-ws-"));
  roots.push(root);
  await writeFile(
    join(root, "codicora.yaml"),
    "spec: codicora/v1\nproject:\n  id: river\n  title: The River\n",
  );
  for (const dir of withEdited ? ["manuscript", "edited"] : ["manuscript"]) {
    await mkdir(join(root, dir, "chapters"), { recursive: true });
    await writeFile(
      join(root, dir, "manuscript.yaml"),
      `schema_version: 1\nlanguage: en\nchapters:\n  - slug: 01-dawn\n    title: "Dawn"\n  - slug: 02-night\n    title: Night\n`,
    );
    await writeFile(
      join(root, dir, "chapters", "01-dawn.md"),
      dir === "edited" ? chapterOne.replace("dawn", "first light") : chapterOne,
    );
    await writeFile(
      join(root, dir, "chapters", "02-night.md"),
      "No markers here, one implicit scene.\n",
    );
  }
  return root;
}

describe("chapter round trip", () => {
  it("keeps scene ids, paragraphs, line breaks, headings and emphasis through XHTML", () => {
    const back = chapterMarkdown(
      chapterXhtml({ slug: "01-dawn", title: "Dawn", text: chapterOne }, "en"),
    );
    expect(back.title).toBe("Dawn");
    expect(back.text).toBe(chapterOne);
  });
  it("gives text before the first marker the implicit id s0", () => {
    const back = chapterMarkdown(
      chapterXhtml({ slug: "x", title: "X", text: "Just text.\n" }, "en"),
    );
    expect(back.text).toBe("<!-- scene: s0 -->\nJust text.\n");
  });
});

describe("workspace mode over HTTP", () => {
  async function server() {
    const dataDir = await mkdtemp(join(tmpdir(), "trucheman-ws-data-"));
    roots.push(dataDir);
    const { app, orchestrator } = createApp(dataDir);
    const listening = app.listen(0, "127.0.0.1");
    await new Promise((ok) => listening.once("listening", ok));
    const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api/jobs`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    };
    return {
      call,
      dataDir,
      close: async () => {
        await orchestrator.drain();
        listening.close();
      },
    };
  }

  it("translates edited/ when it exists and writes localization/<lang>/ with the same slugs and scenes", async () => {
    const ws = await workspace(true);
    const { call, close, dataDir } = await server();
    try {
      const { body: job } = await call("POST", "", { targetLanguage: "ru" });
      const linked = await call("PUT", `/${job.id}/workspace`, { path: ws });
      expect(linked.status).toBe(200);
      expect(linked.body).toMatchObject({
        title: "The River",
        sourceLanguage: "en",
        workspaceText: "edited",
      });
      expect(JSON.stringify(linked.body)).not.toContain(ws); // paths stay server-side

      expect((await call("POST", `/${job.id}/analyze`)).status).toBe(202);
      await vi.waitFor(
        async () => expect((await call("GET", `/${job.id}`)).body.status).toBe("ready"),
        { timeout: 15000 },
      );
      expect((await call("POST", `/${job.id}/start`)).status).toBe(202);
      await vi.waitFor(
        async () => expect((await call("GET", `/${job.id}`)).body.stage).toBe("complete"),
        { timeout: 30000 },
      );

      const out = join(ws, "localization", "ru");
      // No waiting here: "complete" is only saved after the export.
      await readFile(join(out, "manuscript.yaml")).catch(async () => {
        throw new Error(await readFile(join(dataDir, "events.ndjson"), "utf8"));
      });
      const manifest = parseYaml(await readFile(join(out, "manuscript.yaml"), "utf8"));
      expect(manifest).toMatchObject({
        schema_version: 1,
        language: "ru",
        generated_by: "trucheman",
      });
      expect(manifest.translated_from).toMatchObject({ text: "edited", current: true });
      expect(manifest.chapters.map((c: { slug: string }) => c.slug)).toEqual([
        "01-dawn",
        "02-night",
      ]);
      expect((await readdir(join(out, "chapters"))).sort()).toEqual(["01-dawn.md", "02-night.md"]);
      const one = await readFile(join(out, "chapters", "01-dawn.md"), "utf8");
      expect([...one.matchAll(/<!-- scene: (\S+) -->/g)].map((m) => m[1])).toEqual([
        "4f2e9b1c",
        "9a0b",
      ]);
      expect(one.split(/\n{2,}/).length).toBe(chapterOne.split(/\n{2,}/).length);
      expect(await readFile(join(ws, "edited", "chapters", "01-dawn.md"), "utf8")).toContain(
        "first light",
      ); // the original is untouched
    } finally {
      await close();
    }
  }, 60000);

  it("re-reading the same project keeps the work: only the changed chapter is translated again", async () => {
    const ws = await workspace(false);
    const { call, close, dataDir } = await server();
    const drafts = async (id: string) =>
      (await readFile(join(dataDir, "jobs", id, "drafts.ndjson"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean).length;
    const run = async (id: string) => {
      expect((await call("POST", `/${id}/analyze`)).status).toBe(202);
      await vi.waitFor(
        async () => expect((await call("GET", `/${id}`)).body.status).toBe("ready"),
        {
          timeout: 15000,
        },
      );
      expect((await call("POST", `/${id}/start`)).status).toBe(202);
      await vi.waitFor(
        async () => expect((await call("GET", `/${id}`)).body.stage).toBe("complete"),
        { timeout: 30000 },
      );
    };
    try {
      const { body: job } = await call("POST", "", { targetLanguage: "ru" });
      await call("PUT", `/${job.id}/workspace`, { path: ws });
      await run(job.id);
      const first = await drafts(job.id);
      expect(first).toBeGreaterThanOrEqual(2); // one batch per chapter at least

      await writeFile(
        join(ws, "manuscript", "chapters", "02-night.md"),
        "No markers here, one implicit scene. Now with a second sentence.\n",
      );
      // The run holds the job for a moment after "complete" is saved; a person never sees it.
      await vi.waitFor(
        async () => expect((await call("POST", `/${job.id}/refresh-workspace`)).status).toBe(200),
        { timeout: 10000 },
      );
      await run(job.id);
      expect((await drafts(job.id)) - first).toBe(1); // the edited chapter's single batch, nothing else

      const night = await readFile(
        join(ws, "localization", "ru", "chapters", "02-night.md"),
        "utf8",
      );
      expect(night).toContain("second sentence");
      const manifest = parseYaml(
        await readFile(join(ws, "localization", "ru", "manuscript.yaml"), "utf8"),
      );
      expect(manifest.translated_from.current).toBe(true);
    } finally {
      await close();
    }
  }, 90000);

  it("reads manuscript/ when there is no edited/, and refuses a folder that is not a workspace", async () => {
    const ws = await workspace(false);
    const { call, close } = await server();
    try {
      const { body: job } = await call("POST", "", { targetLanguage: "ru" });
      expect((await call("PUT", `/${job.id}/workspace`, { path: ws })).body.workspaceText).toBe(
        "manuscript",
      );
      expect((await call("PUT", `/${job.id}/workspace`, { path: tmpdir() })).status).toBe(400);
      expect((await call("POST", `/${job.id}/export-workspace`)).status).toBe(409);
    } finally {
      await close();
    }
  });
});
