import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWrite } from "../../src/server/storage/atomic-file.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atomic-file-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomicWrite", () => {
  it("replaces the destination and leaves no temporary file", async () => {
    const root = await temporaryRoot(),
      destination = join(root, "state.json");
    await atomicWrite(destination, "old");
    await atomicWrite(destination, "new");
    expect(await readFile(destination, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  it("supports concurrent writers without temporary-name collisions", async () => {
    const root = await temporaryRoot(),
      destination = join(root, "state.json");
    const values = Array.from({ length: 16 }, (_, index) => `value-${index}`);
    await Promise.all(values.map((value) => atomicWrite(destination, value)));
    expect(values).toContain(await readFile(destination, "utf8"));
    expect(await readdir(root)).toEqual(["state.json"]);
  });
});
