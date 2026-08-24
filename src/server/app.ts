import express from "express";
import { rateLimit } from "express-rate-limit";
import { join } from "node:path";
import { jobsRouter } from "./api/jobs.js";
import { settingsRouter } from "./api/settings.js";
import { JobRepository } from "./storage/job-repository.js";
import { jobEventsRouter } from "./api/job-events.js";
import { jobControlRouter } from "./api/job-control.js";
import { jobRetryRouter } from "./api/job-retry.js";
import { jobResultsRouter } from "./api/job-results.js";
import { EventRepository } from "./storage/event-repository.js";
import { JobOrchestrator } from "./jobs/job-orchestrator.js";
import { defaults } from "./config/defaults.js";
import { DomainError } from "./domain/errors.js";
import { problemResponse } from "./api/problem.js";

export function createApp(
  dataDir: string,
  options: { maxUploadBytes?: number; requestsPerMinute?: number } = {},
) {
  const app = express(),
    jobs = new JobRepository(dataDir),
    events = new EventRepository(join(dataDir, "events.ndjson"));
  const orchestrator = new JobOrchestrator(jobs, {
    onEvent: async (jobId, type, message, data) => {
      await events.append({ jobId, type, message, data, timestamp: new Date().toISOString() });
    },
  });
  app.disable("x-powered-by");
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: options.requestsPerMinute ?? 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use(
    express.raw({
      type: ["application/epub+zip", "application/octet-stream"],
      limit: options.maxUploadBytes ?? defaults.maxUploadBytes,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/jobs", jobsRouter(jobs, orchestrator));
  app.use("/api/settings", settingsRouter());
  app.use("/api/jobs", jobEventsRouter(events));
  app.use("/api/jobs", jobControlRouter(jobs, orchestrator));
  app.use("/api/jobs", jobRetryRouter(jobs, orchestrator));
  app.use("/api/jobs", jobResultsRouter(jobs, orchestrator));
  app.get("/api/health", (_q, res) => res.json({ ok: true }));
  const client = join(process.cwd(), "dist/client");
  app.use(express.static(client));
  // Unknown API routes must not resolve to the SPA shell with a 200.
  app.use("/api", (req, res) =>
    problemResponse(res, new DomainError("not_found", "Unknown API route", 404), req),
  );
  app.use((_q, res) => res.sendFile(join(client, "index.html")));
  return { app, jobs, events, orchestrator };
}
