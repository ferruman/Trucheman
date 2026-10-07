import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const status = (port: number, method: string, headers: Record<string, string>) =>
  new Promise<number>((ok, fail) =>
    request({ host: "127.0.0.1", port, path: "/api/jobs", method, headers }, (r) => {
      r.resume();
      ok(r.statusCode ?? 0);
    })
      .on("error", fail)
      .end(),
  );

describe("loopback protection", () => {
  it("refuses a rebinding Host and a cross-origin write", async () => {
    const dataDir = await mkdtemp(`${tmpdir()}/trucheman-loopback-`);
    roots.push(dataDir);
    const { app } = createApp(dataDir, { loopbackOnly: true });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address");
      const port = address.port;
      expect(await status(port, "GET", { host: `evil.example:${port}` })).toBe(403);
      expect(
        await status(port, "POST", { host: `127.0.0.1:${port}`, origin: "https://evil.example" }),
      ).toBe(403);
      expect(await status(port, "GET", { host: `127.0.0.1:${port}` })).toBe(200);
    } finally {
      server.close();
    }
  });
});
