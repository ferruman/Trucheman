import { z } from "zod";
import { jobViewSchema } from "../../shared/api/schemas.js";
import {
  canTransition,
  transition,
  type JobStatus,
  type JobStage,
  type Progress,
} from "../../shared/domain/job.js";
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
  documents: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        title: z.string(),
        total: z.number(),
        translated: z.number(),
        edited: z.number(),
        status: z.string(),
      }),
    )
    .default([]),
  instructions: z.string().default(""),
  glossary: z.array(z.unknown()).default([]),
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
    currentDocument: job.documents.find((d) => d.status === "running")?.title,
    warnings: job.warnings,
  });
}
