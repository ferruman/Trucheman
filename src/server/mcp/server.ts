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
import { readWorkspace } from "../workspace/codicora.js";
import { authorize, estimateUsd, journal, CURRENCY } from "./authority.js";

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
      "critic and selective repair on top of translation, literary editing and consistency. " +
      "It spends on every stage's model, so without confirm it only describes the job and " +
      "creates nothing; pass confirm: true only after the author said yes in this conversation.",
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
      confirm: z
        .boolean()
        .default(false)
        .describe("The author's yes to this paid run; without it nothing is created"),
    },
  },
  async ({ path, title, sourceLanguage, targetLanguage, quality, instructions, confirm }) => {
    const file = resolve(path);
    const { size } = await stat(file);
    // An EPUB outside any workspace has no delegations.json to consult, so only the author's direct
    // word starts it (../DELEGATION.md §8); translate_workspace is the delegatable path.
    if (!confirm)
      return text({
        requires_confirm: true,
        would_translate: {
          path: file,
          bytes: size,
          title: title ?? basename(file, ".epub"),
          sourceLanguage,
          targetLanguage,
          quality,
        },
        note: "Paid: every stage calls its configured model. Show this to the author and call again with confirm: true only after they agree.",
      });
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
    return text(summary(await analyzeAndStart(job.id)));
  },
);

/** Analysis segments the book on the single job slot; start rejects an active job, so wait for it. */
async function analyzeAndStart(id: string) {
  let current = await api<JobView>(`/jobs/${id}/analyze`, { method: "POST" });
  for (
    let attempt = 0;
    attempt < 120 && ["created", "analyzing"].includes(current.status);
    attempt++
  ) {
    await sleep(1000);
    current = await api<JobView>(`/jobs/${id}`);
  }
  if (current.status !== "ready")
    throw new Error(`Analysis ended in status "${current.status}"; check the job in the UI.`);
  return api<JobView>(`/jobs/${id}/start`, { method: "POST" });
}

// mcp:<client> from the initialize handshake (DELEGATION.md §1); the agent is never recorded as the author.
const actor = () => `mcp:${server.server.getClientVersion()?.name ?? "unknown"}`;

server.registerTool(
  "translate_workspace",
  {
    description:
      "Workspace mode: translate a Codicora project's text (edited/ when it exists, else manuscript/) into " +
      "localization/<lang>/ — call export_workspace when the job completes. Paid. Without confirm or delegation " +
      "it only describes the run (chapters, characters, worst-case cost when configured) and creates nothing. " +
      'confirm: true — the author said yes in this conversation. delegation: "<id>" — the author\'s delegation in ' +
      "<workspace>/authority/delegations.json allows trucheman.translate and its spending limit covers the worst case; " +
      "Trucheman checks that itself and refuses otherwise — then stop and ask the author.",
    inputSchema: {
      workspace: z.string().describe("The project folder (the one with codicora.yaml)"),
      targetLanguage: languageTag,
      text: z.enum(["auto", "edited", "manuscript"]).default("auto"),
      quality: z.enum(["standard", "high"]).default("high"),
      instructions: z.string().max(100_000).optional(),
      confirm: z.boolean().default(false).describe("The author's yes to this paid run"),
      delegation: z
        .string()
        .optional()
        .describe("Instead of confirm: the id of the author's delegation"),
    },
  },
  async ({
    workspace,
    targetLanguage,
    text: choice,
    quality,
    instructions,
    confirm,
    delegation,
  }) => {
    const book = await readWorkspace(workspace, choice);
    const chars = book.chapters.reduce((n, c) => n + c.title.length + c.text.length, 0);
    const estimate = estimateUsd(chars);
    const plan = {
      workspace: book.root,
      text: book.text,
      chapters: book.chapters.length,
      chars,
      sourceLanguage: book.language,
      targetLanguage,
      quality,
      worstCaseUsd: estimate,
    };
    if (!confirm && !delegation)
      return text({
        requires_confirm: true,
        would_translate: plan,
        note: "Paid. Show this to the author; call again with confirm: true after they agree, or with delegation when they delegated trucheman.translate.",
      });
    const granted = confirm
      ? null
      : await authorize(book.root, delegation!, "trucheman.translate", estimate);
    const job = await api<JobView>(
      "/jobs",
      json("POST", { title: book.title, sourceLanguage: book.language || "en", targetLanguage }),
    );
    await api(`/jobs/${job.id}/workspace`, json("PUT", { path: book.root, text: choice }));
    await api(
      `/jobs/${job.id}/config`,
      json("PUT", { qualityMode: quality, ...(instructions ? { instructions } : {}) }),
    );
    const started = await analyzeAndStart(job.id);
    // The worst case is booked against the budget at the start: Trucheman knows tokens, not prices.
    if (granted)
      await journal(granted, {
        capability: "trucheman.translate",
        performed_by: actor(),
        subject: `job ${job.id} → localization/${targetLanguage}`,
        cost: estimate,
        currency: CURRENCY,
        cost_basis: "estimate",
      });
    return text({
      ...summary(started),
      authority: granted ? "delegated" : "direct",
      ...(granted ? { delegation_id: granted.delegation.id, worstCaseUsd: estimate } : {}),
    });
  },
);

server.registerTool(
  "export_workspace",
  {
    description:
      "Write a completed workspace job's translation into the project's localization/<lang>/ (replacing that folder). " +
      "No model call; the run itself was the paid, authorized step.",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => text(await api(`/jobs/${jobId}/export-workspace`, { method: "POST" })),
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
