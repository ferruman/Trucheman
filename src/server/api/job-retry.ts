import { Router } from "express";
import { toJobView } from "../domain/job.js";
import type { JobRepository } from "../storage/job-repository.js";
import type { JobOrchestrator } from "../jobs/job-orchestrator.js";
import { problemResponse } from "./problem.js";
export function jobRetryRouter(_repo: JobRepository, orchestrator: JobOrchestrator) {
  const r = Router();
  r.post("/:id/retry", async (req, res) => {
    try {
      res.status(202).json(toJobView(await orchestrator.retry(req.params.id)));
    } catch (error) {
      problemResponse(res, error, req);
    }
  });
  return r;
}
