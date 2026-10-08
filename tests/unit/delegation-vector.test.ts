// DELEGATION.md §7 as data (../vectors/delegation/): Trucheman's own reading of the contract must reach the same
// decision for every case. Skipped when the Codicora specification is not checked out next to this repository.
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authorize, delegationHash } from "../../src/server/mcp/authority.js";

const vector = fileURLToPath(new URL("../../../vectors/delegation/", import.meta.url));
const kinds: [RegExp, string][] = [
  [/denies/, "refused:denied"],
  [/does not allow/, "refused:not-allowed"],
  [/expired/, "refused:expired"],
  [/not valid before/, "refused:not-yet-valid"],
  [/belongs to workspace/, "refused:other-workspace"],
  [/was revoked at/, "refused:revoked"],
  [/longer than 7 days/, "refused:longer-than-7-days"],
  [/No delegation/, "refused:unknown"],
  [/Over the delegated budget/, "refused:budget"],
  [/no conversion/, "refused:currency"],
];

describe.skipIf(!existsSync(join(vector, "cases.json")))("delegation vector", () => {
  it("decides every case as DELEGATION.md §7 says", async () => {
    const { cases } = JSON.parse(await readFile(join(vector, "cases.json"), "utf8")) as {
      cases: {
        now: string;
        workspace?: string;
        delegation: string;
        capability: string;
        estimate?: number;
        currency?: string;
        expect: string;
      }[];
    };
    for (const c of cases) {
      let ws = vector;
      if (c.workspace) {
        ws = await mkdtemp(join(tmpdir(), "trucheman-deleg-"));
        await cp(vector, ws, { recursive: true });
        await writeFile(
          join(ws, "codicora.yaml"),
          `spec: codicora/v1\nproject:\n  id: ${c.workspace}\n`,
        );
      }
      // Trucheman prices in USD only: an estimate in another currency cannot be compared with the limit.
      const estimate =
        c.estimate === undefined ? 0 : c.currency === "USD" ? c.estimate : Number.NaN;
      let got = "delegated";
      try {
        if (Number.isNaN(estimate)) throw new Error("no conversion");
        await authorize(ws, c.delegation, c.capability, estimate, Date.parse(c.now));
      } catch (error) {
        const message = (error as Error).message;
        got = kinds.find(([re]) => re.test(message))?.[1] ?? `unclassified: ${message}`;
      }
      expect(got, JSON.stringify(c)).toBe(c.expect);
    }
  });
  it("hashes every entry as the vector says, revoked_at excluded", async () => {
    const { delegation_hash } = JSON.parse(await readFile(join(vector, "cases.json"), "utf8")) as {
      delegation_hash: { expected: Record<string, string> };
    };
    const { delegations } = JSON.parse(
      await readFile(join(vector, "authority/delegations.json"), "utf8"),
    ) as { delegations: { id: string }[] };
    for (const d of delegations) expect(delegationHash(d)).toBe(delegation_hash.expected[d.id]);
  });
});
