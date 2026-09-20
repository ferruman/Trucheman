import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { jobRoot } from "../../src/server/storage/job-paths.js";

it("rejects invalid language pairs before deleting completed work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trucheman-config-"));
  const { app, jobs, orchestrator } = createApp(dir);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const base = `http://127.0.0.1:${address.port}/api/jobs`;
    const request = (url: string, method: string, body: unknown) =>
      fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await request(base, "POST", { sourceLanguage: "en", targetLanguage: "en" })).status,
    ).toBe(400);
    const created = await request(base, "POST", { sourceLanguage: "en", targetLanguage: "ru" });
    const { id } = (await created.json()) as { id: string };
    const job = {
      ...(await jobs.get(id)),
      status: "completed" as const,
      stage: "complete" as const,
    };
    await jobs.save(job);
    const root = jobRoot(dir, id);
    const artifacts = ["output.epub", "drafts.ndjson", "edits.ndjson", "quality-report.json"];
    for (const name of artifacts) await writeFile(join(root, name), `original ${name}`);

    for (const body of [
      { targetLanguage: "en" },
      { sourceLanguage: "ru" },
      { targetLanguage: "unsupported" },
    ]) {
      const response = await request(`${base}/${id}/config`, "PUT", body);
      expect(response.status).toBe(400);
      expect(await jobs.get(id)).toEqual(job);
      for (const name of artifacts)
        expect(await readFile(join(root, name), "utf8")).toBe(`original ${name}`);
    }
    // Valid content changes still invalidate old output.
    expect((await request(`${base}/${id}/config`, "PUT", { targetLanguage: "de" })).status).toBe(
      200,
    );
    expect((await jobs.get(id)).targetLanguage).toBe("de");
    await expect(access(join(root, "output.epub"))).rejects.toThrow();
  } finally {
    await orchestrator.drain();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
