import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendJournal, readJournal } from "../../src/server/storage/ndjson-journal.js";
import { spentUnder } from "../../src/server/mcp/authority.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ndjson-journal-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ndjson journal (AUD-005)", () => {
  it("cuts a torn tail before appending, keeps it aside, and later records stay readable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = join(await temporaryRoot(), "drafts.ndjson");
    await writeFile(file, '{"batchId":"valid","segments":[]}\n{"batchId":"torn"');
    await appendJournal(file, { batchId: "after-restart" });
    await appendJournal(file, { batchId: "later" });
    const read = await readJournal<{ batchId: string }>(file);
    expect(read.map((r) => r.batchId)).toEqual(["valid", "after-restart", "later"]);
    expect(await readFile(`${file}.torn`, "utf8")).toContain('{\\"batchId\\":\\"torn\\"');
  });

  it("a whole last record missing only its newline is kept", async () => {
    const file = join(await temporaryRoot(), "edits.ndjson");
    await writeFile(file, '{"batchId":"a"}');
    await appendJournal(file, { batchId: "b" });
    expect((await readJournal<{ batchId: string }>(file)).map((r) => r.batchId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("a bad line inside an old journal is skipped, not the end of it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = join(await temporaryRoot(), "drafts.ndjson");
    await writeFile(
      file,
      '{"batchId":"a"}\n{"batchId":"torn"{"batchId":"lost"}\n{"batchId":"c"}\n',
    );
    expect((await readJournal<{ batchId: string }>(file)).map((r) => r.batchId)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("authority accounting (AUD-004)", () => {
  it("a torn reservation line refuses instead of being counted around", async () => {
    const dir = await temporaryRoot();
    const record = {
      event: "reserve",
      reservation_id: "known",
      delegation_id: "d",
      currency: "USD",
      amount: 9,
    };
    await writeFile(
      join(dir, "trucheman.jsonl"),
      `${JSON.stringify(record)}\n\n${JSON.stringify({ ...record, reservation_id: "torn", amount: 8 }).slice(0, -1)}\n`,
    );
    await expect(spentUnder(dir, "d", "USD")).rejects.toThrow(
      /trucheman\.jsonl line 3 is not a JSON record/,
    );
  });
});
