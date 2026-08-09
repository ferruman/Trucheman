import { Router } from "express";
import { toJobView } from "../domain/job.js";
import type { JobRepository } from "../storage/job-repository.js";
import type { JobOrchestrator } from "../jobs/job-orchestrator.js";
import { problemResponse } from "./problem.js";
export function jobResultsRouter(_repo: JobRepository, orchestrator: JobOrchestrator) {
  const r = Router();
  r.get("/:id/results", async (req, res) => {
    try {
      res.json(await orchestrator.results(req.params.id));
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  r.post("/:id/rebuild", async (req, res) => {
    try {
      const result = await orchestrator.rebuild(req.params.id);
      res.status(202).json({ job: toJobView(result.job), validation: result.validation });
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  return r;
}
