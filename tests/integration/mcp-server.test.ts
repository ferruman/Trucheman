import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      if (req.url === "/api/jobs/j1/config") return reply(200, job("created"));
      if (req.url === "/api/jobs/j1/analyze") return reply(202, job("analyzing"));
      if (req.method === "GET" && req.url === "/api/jobs/j1")
        return reply(200, job(++analyzePolls < 2 ? "analyzing" : "ready"));
      if (req.url === "/api/jobs/j1/start") return reply(202, job("running"));
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
      env: { ...process.env, TRUCHEMAN_URL: base },
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
  it("translate_book creates, uploads, configures, waits for analysis and starts", async () => {
    const epub = join(root, "book.epub");
    await writeFile(epub, Buffer.alloc(1234, 1));
    const result = await client.callTool({
      name: "translate_book",
      arguments: { path: epub, quality: "high", instructions: "Keep honorifics." },
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
});
