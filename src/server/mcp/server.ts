/**
 * MCP server for Trucheman: lets an AI assistant drive a running Trucheman instance over stdio.
 *
 * Deliberately a thin client of the HTTP API rather than a second entry point into the
 * orchestrator: one job runs process-wide, and the UI, the API and this server must all see
 * the same one. Start it with `npm run mcp` while Trucheman is running; `TRUCHEMAN_URL` points
 * at the instance (default http://127.0.0.1:4173).
 */
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LANGUAGES } from "../../shared/languages.js";

const BASE = (process.env.TRUCHEMAN_URL ?? "http://127.0.0.1:4173").replace(/\/$/, "");
const TERMINAL = new Set(["completed", "needs_attention", "failed", "paused"]);
const languageTag = z.enum(LANGUAGES.map((language) => language.tag) as [string, ...string[]]);

type JobView = {
  id: string;
  title: string;
  status: string;
  stage: string;
  progress: { translated: number; edited: number; total: number; failed: number };
  warnings: number;
  qualityMode: string;
  executionMode: string;
};

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}/api${path}`, init);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const problem = (await response.json()) as { title?: string; detail?: string };
      detail = `${problem.title ?? "error"}: ${problem.detail ?? detail}`;
    } catch {
      /* not a problem+json body */
    }
    throw new Error(`Trucheman ${path} → ${detail}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const json = (init: RequestInit["method"], body: unknown): RequestInit => ({
  method: init,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

function summary(job: JobView) {
  const { translated, edited, total, failed } = job.progress;
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    stage: job.stage,
    progress: `translated ${translated}/${total}, edited ${edited}/${total}, failed ${failed}`,
    warnings: job.warnings,
    qualityMode: job.qualityMode,
    executionMode: job.executionMode,
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const server = new McpServer({ name: "trucheman", version: "0.2.0" });

server.registerTool(
  "list_jobs",
  { description: "List every translation job Trucheman knows about, newest first." },
  async () => text((await api<JobView[]>("/jobs")).map(summary)),
);

server.registerTool(
  "translate_book",
  {
    description:
      "Translate an EPUB end to end: create a job, upload the file, configure it, analyze, and " +
      "start the pipeline. Returns immediately with the job; use wait_for_job or job_status to " +
      "follow it and job_report / download_output when it finishes. High quality adds the " +
      "critic and selective repair on top of translation, literary editing and consistency.",
    inputSchema: {
      path: z.string().describe("Absolute or cwd-relative path to the source .epub"),
      title: z.string().max(500).optional().describe("Defaults to the file name"),
      sourceLanguage: languageTag.default("en"),
      targetLanguage: languageTag.default("ru"),
      quality: z.enum(["standard", "high"]).default("high"),
      instructions: z
        .string()
        .max(100_000)
        .optional()
        .describe("Free-text guidance that reaches every stage: house style, name policy, etc."),
    },
  },
  async ({ path, title, sourceLanguage, targetLanguage, quality, instructions }) => {
    const file = resolve(path);
    await stat(file);
    const job = await api<JobView>(
      "/jobs",
      json("POST", {
        title: title ?? basename(file, ".epub"),
        sourceLanguage,
        targetLanguage,
      }),
    );
    await api(`/jobs/${job.id}/source`, {
      method: "PUT",
      headers: { "content-type": "application/epub+zip" },
      body: await readFile(file),
    });
    await api(
      `/jobs/${job.id}/config`,
      json("PUT", { qualityMode: quality, ...(instructions ? { instructions } : {}) }),
    );
    // Analysis is quick (it segments the book) but runs on the single job slot; start rejects
    // an active job, so wait for it to settle.
    let current = await api<JobView>(`/jobs/${job.id}/analyze`, { method: "POST" });
    for (
      let attempt = 0;
      attempt < 120 && ["created", "analyzing"].includes(current.status);
      attempt++
    ) {
      await sleep(1000);
      current = await api<JobView>(`/jobs/${job.id}`);
    }
    if (current.status !== "ready")
      throw new Error(`Analysis ended in status "${current.status}"; check the job in the UI.`);
    return text(summary(await api<JobView>(`/jobs/${job.id}/start`, { method: "POST" })));
  },
);

server.registerTool(
  "job_status",
  {
    description: "Current status, stage and batch progress of a job.",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => text(summary(await api<JobView>(`/jobs/${jobId}`))),
);

server.registerTool(
  "wait_for_job",
  {
    description:
      "Block until the job reaches a terminal state (completed, needs_attention, failed, " +
      "paused) or the timeout passes, then return its status. Call again if it is still running.",
    inputSchema: {
      jobId: z.string(),
      timeoutSeconds: z.number().int().min(5).max(600).default(240),
    },
  },
  async ({ jobId, timeoutSeconds }) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let job = await api<JobView>(`/jobs/${jobId}`);
    while (!TERMINAL.has(job.status) && Date.now() < deadline) {
      await sleep(10_000);
      job = await api<JobView>(`/jobs/${jobId}`);
    }
    return text({ ...summary(job), finished: TERMINAL.has(job.status) });
  },
);

server.registerTool(
  "job_report",
  {
    description:
      "What the run produced: EPUB validation and EPUBCheck, critic findings and repairs, " +
      "consistency decisions, model usage per stage. Available once the job has built output.",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => text(await api(`/jobs/${jobId}/results`)),
);

server.registerTool(
  "download_output",
  {
    description: "Save the translated EPUB to a local path. The job must have finished building.",
    inputSchema: {
      jobId: z.string(),
      to: z.string().describe("Destination file path for the .epub"),
    },
  },
  async ({ jobId, to }) => {
    const response = await fetch(`${BASE}/api/jobs/${jobId}/download`);
    if (!response.ok || !response.body)
      throw new Error(`Trucheman download → ${response.status} ${response.statusText}`);
    const destination = resolve(to);
    // Node's stream types lag the fetch ones; the runtime accepts a web ReadableStream.
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(destination),
    );
    return text({ path: destination, bytes: (await stat(destination)).size });
  },
);

server.registerTool(
  "control_job",
  {
    description:
      "pause a running job, resume a paused one, or retry a job that failed or needs " +
      "attention. Completed checkpoints are reused; only unfinished work is paid for again.",
    inputSchema: { jobId: z.string(), action: z.enum(["pause", "resume", "retry"]) },
  },
  async ({ jobId, action }) =>
    text(summary(await api<JobView>(`/jobs/${jobId}/${action}`, { method: "POST" }))),
);

await server.connect(new StdioServerTransport());
