import { z } from "zod";
import { jobViewSchema } from "../../shared/api/schemas.js";
import { transition, type JobStatus } from "../../shared/domain/job.js";
export const persistedJobSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  sourceLanguage: z.string(),
  targetLanguage: z.string(),
  status: z.string(),
  stage: z.string(),
  progress: z.object({
    translated: z.number(),
    edited: z.number(),
    total: z.number(),
    failed: z.number(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  warnings: z.number().default(0),
  /** Title of the document the run is working on; the per-document array it replaced was
   * written once at analysis and never updated again. */
  currentDocument: z.string().optional(),
  /** SHA-256 of `source.epub` as of the last run; absent on jobs that predate it. */
  sourceFingerprint: z.string().optional(),
  instructions: z.string().default(""),
  glossary: z.array(z.unknown()).default([]),
  qualityMode: z.enum(["standard", "high"]).default("standard"),
});
export type PersistedJob = z.infer<typeof persistedJobSchema>;
export function validateJob(value: unknown): PersistedJob {
  return persistedJobSchema.parse(value);
}
export function changeStatus(job: PersistedJob, status: JobStatus): PersistedJob {
  return {
    ...job,
    status: transition(job.status as JobStatus, status),
    updatedAt: new Date().toISOString(),
  };
}
export function toJobView(job: PersistedJob) {
  return jobViewSchema.parse({
    id: job.id,
    title: job.title,
    sourceLanguage: job.sourceLanguage,
    targetLanguage: job.targetLanguage,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    currentDocument: job.currentDocument,
    warnings: job.warnings,
    qualityMode: job.qualityMode,
  });
}
