import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The MCP server is a client of the HTTP API, so the boundary under test is the sequence of
 * requests it makes for one assistant tool call. A fake Trucheman records them.
 */
const calls: string[] = [];
const authorityWrites: Array<Record<string, unknown>> = [];
let analyzePolls = 0;
const job = (status: string) => ({
  id: "j1",
  title: "Book",
  sourceLanguage: "en",
  targetLanguage: "ru",
  status,
  stage: status === "created" ? "import" : "analysis",
  progress: { translated: 0, edited: 0, total: 3, failed: 0 },
  warnings: 0,
  qualityMode: "high",
  executionMode: "standard",
});

// A failed workspace job, for control_job retry under a delegation; its fingerprint is set once the workspace exists.
let retryRef = "";
let fake: Server;
let base: string;
let client: Client;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "trucheman-mcp-"));
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push(`${req.method} ${req.url}${body.length ? ` ${body.length}b` : ""}`);
      const reply = (status: number, value?: unknown, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(value === undefined ? undefined : JSON.stringify(value));
      };
      if (req.method === "POST" && req.url === "/api/jobs") return reply(201, job("created"));
      if (req.url === "/api/jobs/j1/source") return reply(204);
      if (req.url === "/api/jobs/j1/workspace") return reply(200, job("created"));
      if (req.url === "/api/jobs/j1/export-workspace")
        return reply(200, { language: "en", chapters: 1 });
      if (req.url === "/api/jobs/j1/config") return reply(200, job("created"));
      if (req.method === "PUT" && /^\/api\/jobs\/j[12]\/authority$/.test(req.url ?? "")) {
        authorityWrites.push(JSON.parse(body.toString()));
        return reply(200, job("created"));
      }
      if (req.url === "/api/jobs/j1/analyze") return reply(202, job("analyzing"));
      if (req.method === "GET" && req.url === "/api/jobs/j1")
        return reply(200, job(++analyzePolls < 2 ? "analyzing" : "ready"));
      if (req.url === "/api/jobs/j1/start") return reply(202, job("running"));
      if (req.method === "GET" && req.url === "/api/jobs/j2")
        return reply(200, {
          ...job("failed"),
          id: "j2",
          workspaceRef: retryRef,
          workspaceText: "manuscript",
        });
      if (req.url === "/api/jobs/j2/resume") return reply(202, { ...job("running"), id: "j2" });
      if (req.url === "/api/jobs/j2/retry") return reply(202, { ...job("running"), id: "j2" });
      if (req.url === "/api/jobs/j1/retry") return reply(202, job("running"));
      if (req.url === "/api/jobs/j1/download") {
        res.writeHead(200, { "content-type": "application/epub+zip" });
        return res.end(Buffer.from("PK-epub-bytes"));
      }
      if (req.url === "/api/jobs/missing")
        return reply(
          404,
          { title: "job_not_found", detail: "No such job", status: 404 },
          "application/problem+json",
        );
      reply(500, { title: "unexpected", detail: req.url });
    });
  });
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const address = fake.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx/esm", "src/server/mcp/server.ts"],
      env: { ...process.env, TRUCHEMAN_URL: base, TRUCHEMAN_MAX_USD_PER_MILLION_CHARS: "20000" },
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((done) => fake?.close(() => done()));
  await rm(root, { recursive: true, force: true });
});

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

describe("MCP server over the HTTP API", () => {
  it("translate_book without confirm only describes the paid run and creates nothing", async () => {
    const epub = join(root, "book.epub");
    await writeFile(epub, Buffer.alloc(1234, 1));
    const before = calls.length;
    const result = await client.callTool({ name: "translate_book", arguments: { path: epub } });
    expect(JSON.parse(text(result))).toMatchObject({
      requires_confirm: true,
      would_translate: { bytes: 1234, quality: "high" },
    });
    expect(calls.length).toBe(before);
  });

  it("translate_book creates, uploads, configures, waits for analysis and starts", async () => {
    const epub = join(root, "book.epub");
    await writeFile(epub, Buffer.alloc(1234, 1));
    const result = await client.callTool({
      name: "translate_book",
      arguments: { path: epub, quality: "high", instructions: "Keep honorifics.", confirm: true },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ id: "j1", status: "running" });
    expect(calls).toEqual([
      `POST /api/jobs ${JSON.stringify({ title: "book", sourceLanguage: "en", targetLanguage: "ru" }).length}b`,
      "PUT /api/jobs/j1/source 1234b",
      `PUT /api/jobs/j1/config ${JSON.stringify({ qualityMode: "high", instructions: "Keep honorifics." }).length}b`,
      "POST /api/jobs/j1/analyze",
      "GET /api/jobs/j1",
      "GET /api/jobs/j1",
      "POST /api/jobs/j1/start",
    ]);
  }, 30_000);

  it("download_output writes the EPUB where asked", async () => {
    const to = join(root, "out.epub");
    const result = await client.callTool({
      name: "download_output",
      arguments: { jobId: "j1", to },
    });
    expect(JSON.parse(text(result))).toEqual({ path: to, bytes: 13 });
    expect((await readFile(to)).toString()).toBe("PK-epub-bytes");
  });

  it("surfaces the API's problem detail instead of a bare status code", async () => {
    const result = await client.callTool({ name: "job_status", arguments: { jobId: "missing" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("job_not_found: No such job");
  });

  describe("workspace mode under delegated authority (DELEGATION.md)", () => {
    let ws: string;
    const grant = async (allow: string[], extra: Record<string, unknown> = {}) =>
      writeFile(
        join(ws, "authority", "delegations.json"),
        JSON.stringify({
          schema: "codicora.delegations/0.1",
          delegations: [
            {
              id: "run",
              workspace: "vec",
              granted_by: "author",
              granted_at: new Date(Date.now() - 60_000).toISOString(),
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              allow,
              limits: { max_spend: 10, currency: "USD" },
              ...extra,
            },
          ],
        }),
      );
    const call = (args: Record<string, unknown>) =>
      client.callTool({
        name: "translate_workspace",
        arguments: { workspace: ws, targetLanguage: "en", ...args },
      });

    beforeAll(async () => {
      ws = join(root, "ws");
      await mkdir(join(ws, "manuscript", "chapters"), { recursive: true });
      await mkdir(join(ws, "authority"), { recursive: true });
      await writeFile(
        join(ws, "codicora.yaml"),
        "spec: codicora/v1\nproject:\n  id: vec\n  title: Vec\n",
      );
      await writeFile(
        join(ws, "manuscript", "manuscript.yaml"),
        "schema_version: 1\nlanguage: ru\nchapters:\n  - slug: ch-01\n    title: Один\n",
      );
      await writeFile(
        join(ws, "manuscript", "chapters", "ch-01.md"),
        "<!-- scene: s1 -->\n" + "Текст. ".repeat(40),
      );
    });

    it("without confirm or delegation: a description with the worst case, nothing created", async () => {
      const before = calls.length;
      const plan = JSON.parse(text(await call({})));
      expect(plan).toMatchObject({
        requires_confirm: true,
        would_translate: { chapters: 1, worstCaseUsd: expect.any(Number) },
      });
      expect(calls.length).toBe(before);
    });

    it("refuses a delegation without trucheman.translate, a revoked one, and one whose budget is too small — before any request", async () => {
      const before = calls.length;
      await grant(["fabellatrix.generate"]);
      expect(text(await call({ delegation: "run" }))).toMatch(/does not allow trucheman.translate/);
      await grant(["trucheman.translate"], {
        revoked_at: new Date(Date.now() - 1000).toISOString(),
      });
      expect(text(await call({ delegation: "run" }))).toMatch(/revoked/);
      await grant(["trucheman.translate"]);
      await writeFile(
        join(ws, "authority", "esgardeor.jsonl"),
        JSON.stringify({ delegation_id: "run", cost: 9.9, currency: "USD" }) + "\n",
      );
      expect(text(await call({ delegation: "run" }))).toMatch(/Over the delegated budget/);
      await rm(join(ws, "authority", "esgardeor.jsonl"));
      expect(calls.length).toBe(before);
    });

    it("a covering delegation runs without confirmation, books the worst case and names the agent", async () => {
      await grant(["trucheman.translate"]);
      const before = calls.length;
      const result = JSON.parse(text(await call({ delegation: "run", quality: "standard" })));
      expect(result).toMatchObject({
        status: "running",
        authority: "delegated",
        delegation_id: "run",
      });
      expect(calls.slice(before).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([
        "POST /api/jobs",
        "PUT /api/jobs/j1/workspace",
        "PUT /api/jobs/j1/config",
        "PUT /api/jobs/j1/authority",
        "POST /api/jobs/j1/analyze",
        "GET /api/jobs/j1",
        "POST /api/jobs/j1/start",
      ]);
      const [reserved, line] = (await readFile(join(ws, "authority", "trucheman.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      // The worst case was reserved before the job was created and started (DELEGATION.md §4).
      expect(reserved).toMatchObject({
        event: "reserve",
        amount: result.worstCaseUsd,
        currency: "USD",
        delegation_id: "run",
      });
      expect(line.delegation_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(line).toMatchObject({
        capability: "trucheman.translate",
        performed_by: "mcp:test",
        authority: "delegated",
        authorized_by: "author",
        delegation_id: "run",
        reservation_id: reserved.reservation_id,
      });
      expect(
        JSON.parse(
          text(await client.callTool({ name: "export_workspace", arguments: { jobId: "j1" } })),
        ),
      ).toEqual({ language: "en", chapters: 1 });
    }, 30_000);

    it("resume under a supplied delegation needs a spending limit and reserves before the API continues", async () => {
      const { workspaceRef } = await import("../../src/server/domain/job.js");
      retryRef = workspaceRef(ws);
      const resume = () =>
        client.callTool({
          name: "control_job",
          arguments: { jobId: "j2", action: "resume", workspace: ws, delegation: "run" },
        });
      const before = calls.length;
      await grant(["trucheman.translate"], { limits: undefined });
      expect(text(await resume())).toMatch(/sets no spending limit/);
      await grant(["trucheman.translate"], { limits: { max_spend: 0, currency: "USD" } });
      expect(text(await resume())).toMatch(/Over the delegated budget/);
      expect(
        calls.slice(before).filter((c) => c.includes("/authority") || c.includes("/resume")),
      ).toEqual([]);
      await grant(["trucheman.translate"], { limits: { max_spend: 100, currency: "USD" } });
      expect(JSON.parse(text(await resume()))).toMatchObject({ id: "j2", status: "running" });
      const records = (await readFile(join(ws, "authority/trucheman.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const reservation = records.at(-2);
      expect(reservation).toMatchObject({
        event: "reserve",
        subject: "resume of job j2",
        amount: expect.any(Number),
      });
      expect(authorityWrites.at(-1)).toMatchObject({
        authority: "delegated",
        reservation_id: reservation.reservation_id,
      });
      expect(calls.at(-1)).toBe("POST /api/jobs/j2/resume");
    });

    it("retry pays again: described without authority, booked again under a delegation, refused when it does not fit", async () => {
      const { createHash } = await import("node:crypto");
      const { resolve } = await import("node:path");
      retryRef = `sha256:${createHash("sha256").update(resolve(ws), "utf8").digest("hex")}`;
      const retry = (jobId: string, args: Record<string, unknown> = {}) =>
        client.callTool({
          name: "control_job",
          arguments: { jobId, action: "retry", workspace: ws, ...args },
        });
      await grant(["trucheman.translate"], { limits: { max_spend: 100, currency: "USD" } });
      const before = calls.length;
      expect(JSON.parse(text(await retry("j2")))).toMatchObject({
        requires_confirm: true,
        worstCaseUsd: expect.any(Number),
      });
      expect(text(await retry("j1", { delegation: "run" }))).toMatch(/EPUB outside any workspace/);
      const { cp } = await import("node:fs/promises");
      await cp(ws, join(root, "other"), { recursive: true });
      expect(
        text(await retry("j2", { delegation: "run", workspace: join(root, "other") })),
      ).toMatch(/was not translated from/);
      await writeFile(
        join(ws, "authority", "esgardeor.jsonl"),
        JSON.stringify({ delegation_id: "run", cost: 90, currency: "USD" }) + "\n",
      );
      expect(text(await retry("j2", { delegation: "run" }))).toMatch(/Over the delegated budget/);
      await rm(join(ws, "authority", "esgardeor.jsonl"));
      expect(calls.slice(before).filter((c) => c.includes("/retry"))).toEqual([]);

      expect(JSON.parse(text(await retry("j2", { delegation: "run" })))).toMatchObject({
        status: "running",
        authority: "delegated",
      });
      expect(calls.at(-1)).toBe("POST /api/jobs/j2/retry");
      const lines = (await readFile(join(ws, "authority", "trucheman.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines.at(-2)).toMatchObject({
        event: "reserve",
        subject: "retry of job j2",
        amount: expect.any(Number),
      });
      expect(lines.at(-1)).toMatchObject({
        capability: "trucheman.translate",
        subject: "retry of job j2",
        performed_by: "mcp:test",
        reservation_id: lines.at(-2).reservation_id,
      });
      expect(JSON.parse(text(await retry("j1", { confirm: true })))).toMatchObject({
        authority: "direct",
      });
    }, 30_000);
  });
});
