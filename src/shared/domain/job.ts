export const JOB_STATUSES = [
  "created",
  "analyzing",
  "ready",
  "running",
  "stopping",
  "paused",
  "needs_attention",
  "completed",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STAGES = [
  "import",
  "analysis",
  "translation",
  "editing",
  "audit",
  "repair",
  "building",
  "validation",
  "complete",
] as const;
export type JobStage = (typeof JOB_STAGES)[number];
export const QUALITY_MODES = ["standard", "high"] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];
export type Progress = { translated: number; edited: number; total: number; failed: number };
export type JobView = {
  id: string;
  title: string;
  sourceLanguage: string;
  targetLanguage: string;
  status: JobStatus;
  stage: JobStage;
  progress: Progress;
  createdAt: string;
  updatedAt: string;
  currentDocument?: string;
  warnings: number;
  qualityMode: QualityMode;
};
export function progressFor(
  translated: number,
  edited: number,
  total: number,
  failed = 0,
): Progress {
  if (
    ![translated, edited, total, failed].every(Number.isInteger) ||
    total < 0 ||
    translated < 0 ||
    edited < 0 ||
    failed < 0 ||
    translated > total ||
    edited > translated ||
    failed > total
  )
    throw new Error("Invalid progress invariant");
  return { translated, edited, total, failed };
}
const transitions: Record<JobStatus, readonly JobStatus[]> = {
  created: ["analyzing", "failed"],
  analyzing: ["ready", "failed", "paused"],
  ready: ["running", "failed"],
  running: ["stopping", "paused", "needs_attention", "completed", "failed"],
  stopping: ["paused", "needs_attention", "failed"],
  paused: ["analyzing", "running", "failed"],
  needs_attention: ["running", "paused", "failed"],
  completed: ["running"],
  failed: ["running"],
};
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}
export function transition(from: JobStatus, to: JobStatus): JobStatus {
  if (!canTransition(from, to)) throw new Error(`Illegal job transition ${from} -> ${to}`);
  return to;
}
