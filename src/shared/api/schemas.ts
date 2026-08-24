import { z } from "zod";
import { EXECUTION_MODES, JOB_STAGES, JOB_STATUSES, QUALITY_MODES } from "../domain/job.js";
import { LANGUAGES } from "../languages.js";
export const languageSchema = z.enum(LANGUAGES.map((x) => x.tag) as [string, ...string[]]);
export const jobStatusSchema = z.enum(JOB_STATUSES);
export const jobStageSchema = z.enum(JOB_STAGES);
export const progressSchema = z.object({
  translated: z.number().int().nonnegative(),
  edited: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export const jobViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceLanguage: languageSchema,
  targetLanguage: languageSchema,
  status: jobStatusSchema,
  stage: jobStageSchema,
  progress: progressSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  currentDocument: z.string().optional(),
  warnings: z.number().int().nonnegative(),
  qualityMode: z.enum(QUALITY_MODES),
  executionMode: z.enum(EXECUTION_MODES),
});
export const glossaryEntrySchema = z.object({
  id: z.string(),
  source: z.string().min(1),
  target: z.string(),
  category: z.string().min(1),
  note: z.string().optional(),
  enabled: z.boolean(),
  aliasOf: z.string().optional(),
});
export const segmentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
  text: z.string(),
  sourceHash: z.string(),
  locator: z.array(z.number().int().nonnegative()),
  leading: z.string(),
  trailing: z.string(),
});
export const providerResultSchema = z.object({
  segments: z.array(z.object({ id: z.string(), text: z.string().min(1) })),
});
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
});
export const eventSchema = z.object({
  id: z.number().int().positive(),
  type: z.string(),
  timestamp: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type JobViewResponse = z.infer<typeof jobViewSchema>;
