import { Router } from "express";
import { z } from "zod";
import { toJobView } from "../domain/job.js";
import { DomainError } from "../domain/errors.js";
import type { JobRepository } from "../storage/job-repository.js";
import type { JobOrchestrator } from "../jobs/job-orchestrator.js";
import { problemResponse } from "./problem.js";

const invalidationSchema=z.object({batchId:z.string().min(1).optional(),scopes:z.array(z.unknown()).optional()}).strict();
function parseInvalidation(value:unknown){const result=invalidationSchema.safeParse(value);if(!result.success)throw new DomainError("invalid_request",result.error.issues.map(issue=>issue.message).join("; "),400);return result.data;}

export function jobControlRouter(_repo:JobRepository,orchestrator:JobOrchestrator){
  const r=Router();
  r.post("/:id/pause",async(req,res)=>{try{res.json(toJobView(await orchestrator.pause(req.params.id)));}catch(error){problemResponse(res,error,req);}});
  r.post("/:id/resume",async(req,res)=>{try{res.status(202).json(toJobView(await orchestrator.resume(req.params.id)));}catch(error){problemResponse(res,error,req);}});
  r.post("/:id/invalidate",async(req,res)=>{try{const {batchId}=parseInvalidation(req.body??{});res.json(toJobView(await orchestrator.invalidate(req.params.id,batchId)));}catch(error){problemResponse(res,error,req);}});
  return r;
}
