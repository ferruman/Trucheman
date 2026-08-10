import { Router } from "express";
import { createReadStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertLanguagePair } from "../../shared/languages.js";
import { glossaryEntrySchema, languageSchema } from "../../shared/api/schemas.js";
import { newJobId, jobRoot } from "../storage/job-paths.js";
import { type JobRepository } from "../storage/job-repository.js";
import { type PersistedJob, toJobView } from "../domain/job.js";
import { problemResponse } from "./problem.js";
import { DomainError } from "../domain/errors.js";
import { JobOrchestrator } from "../jobs/job-orchestrator.js";
import { atomicWrite } from "../storage/atomic-file.js";

const createJobSchema = z
  .object({
    title: z.string().trim().min(1).max(500).default("Untitled book"),
    sourceLanguage: languageSchema.default("en"),
    targetLanguage: languageSchema,
  })
  .strict();
const configSchema = z
  .object({
    sourceLanguage: languageSchema.optional(),
    targetLanguage: languageSchema.optional(),
    instructions: z.string().max(100_000).optional(),
    glossary: z.array(glossaryEntrySchema).max(10_000).optional(),
    qualityMode: z.enum(["standard", "high"]).optional(),
  })
  .strict();
function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError(
      "invalid_request",
      result.error.issues.map((issue) => issue.message).join("; "),
      400,
    );
  return result.data;
}
export function parseJobConfig(value: unknown) {
  return parseBody(configSchema, value);
}

export function jobsRouter(repo: JobRepository, orchestrator: JobOrchestrator) {
  const router = Router();
  router.get("/", async (_req, res) => res.json((await orchestrator.listJobs()).map(toJobView)));
  router.post("/", async (req, res) => {
    try {
      const { title, sourceLanguage, targetLanguage } = parseBody(createJobSchema, req.body);
      assertLanguagePair(sourceLanguage, targetLanguage);
      const id = newJobId(),
        now = new Date().toISOString();
      const job: PersistedJob = {
        version: 1,
        id,
        title,
        sourceLanguage,
        targetLanguage,
        status: "created",
        stage: "import",
        progress: { translated: 0, edited: 0, total: 0, failed: 0 },
        createdAt: now,
        updatedAt: now,
        warnings: 0,
        documents: [],
        instructions: "",
        glossary: [],
        qualityMode: "standard",
      };
      await repo.save(job);
      res.status(201).json(toJobView(job));
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  router.get("/:id", async (req, res) => {
    try {
      res.json(toJobView(await orchestrator.getJob(req.params.id)));
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  router.put("/:id/config", async (req, res) => {
    try {
      const job = await repo.get(req.params.id);
      orchestrator.assertMutable(job.id, job);
      const body = parseJobConfig(req.body);
      const changesContent =
        (body.sourceLanguage !== undefined && body.sourceLanguage !== job.sourceLanguage) ||
        (body.targetLanguage !== undefined && body.targetLanguage !== job.targetLanguage) ||
        (body.instructions !== undefined && body.instructions !== job.instructions) ||
        (body.glossary !== undefined &&
          JSON.stringify(body.glossary) !== JSON.stringify(job.glossary));
      const changesQuality = body.qualityMode !== undefined && body.qualityMode !== job.qualityMode;
      const base = changesContent
        ? await orchestrator.invalidate(job.id)
        : changesQuality && job.status !== "created"
          ? await orchestrator.invalidateQuality(job.id)
          : job;
      const next: PersistedJob = {
        ...base,
        sourceLanguage: body.sourceLanguage ?? base.sourceLanguage,
        targetLanguage: body.targetLanguage ?? base.targetLanguage,
        instructions: body.instructions ?? base.instructions,
        glossary: body.glossary ?? base.glossary,
        qualityMode: body.qualityMode ?? base.qualityMode,
        updatedAt: new Date().toISOString(),
      };
      assertLanguagePair(next.sourceLanguage, next.targetLanguage);
      await repo.save(next);
      res.json(toJobView(next));
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  router.put("/:id/source", async (req, res) => {
    try {
      const job = await repo.get(req.params.id);
      orchestrator.assertMutable(job.id, job);
      const root = jobRoot(repo.dataDir, job.id);
      await mkdir(root, { recursive: true });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new DomainError("upload_missing", "An EPUB upload is required", 400);
      const base = job.status === "created" ? job : await orchestrator.invalidate(job.id);
      await atomicWrite(join(root, "source.epub"), req.body);
      await repo.save({
        ...base,
        status: "created",
        stage: "import",
        progress: { translated: 0, edited: 0, total: 0, failed: 0 },
        documents: [],
        updatedAt: new Date().toISOString(),
      });
      res.status(204).end();
    } catch (error) {
      console.error("EPUB upload failed", error instanceof Error ? error.message : "unknown error");
      problemResponse(res, error, req);
    }
  });
  router.post("/:id/analyze", async (req, res) => {
    try {
      res.status(202).json(toJobView(await orchestrator.analyze(req.params.id)));
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  router.post("/:id/start", async (req, res) => {
    try {
      res.status(202).json(toJobView(await orchestrator.start(req.params.id)));
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  router.get("/:id/download", async (req, res) => {
    try {
      const job = await repo.get(req.params.id);
      if (job.status !== "completed")
        throw new DomainError("output_not_ready", "The translated EPUB is not ready", 409);
      const path = join(jobRoot(repo.dataDir, req.params.id), "output.epub");
      await access(path);
      res.attachment(`${job.title.replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 120)}.epub`);
      res.type("application/epub+zip");
      createReadStream(path)
        .on("error", (error) => problemResponse(res, error, req))
        .pipe(res);
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  router.delete("/:id", async (req, res) => {
    try {
      const job = await repo.get(req.params.id);
      orchestrator.assertMutable(job.id, job);
      await repo.remove(req.params.id);
      res.status(204).end();
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  return router;
}
