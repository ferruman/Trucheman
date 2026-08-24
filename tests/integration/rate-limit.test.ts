import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("HTTP rate limiting", () => {
  it("rejects requests after the configured per-client budget", async () => {
    const dataDir = await mkdtemp(`${tmpdir()}/trucheman-rate-limit-`);
    roots.push(dataDir);
    const { app } = createApp(dataDir, { requestsPerMinute: 2 });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address");
      const endpoint = `http://127.0.0.1:${address.port}/api/health`;
      const statuses = [];
      for (let index = 0; index < 3; index += 1) {
        statuses.push((await fetch(endpoint)).status);
      }
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
