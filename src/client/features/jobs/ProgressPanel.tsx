import type { JobView } from "../../../shared/domain/job";

export function ProgressPanel({ job }: { job: JobView }) {
  return <section aria-label="Progress">
    <p role="status" aria-live="polite" aria-atomic="true">Status: {job.status}. Stage: {job.stage}.</p>
    {job.currentDocument && <p>Current chapter: {job.currentDocument}</p>}
    <p>Translated: {job.progress.translated}/{job.progress.total}. Edited: {job.progress.edited}/{job.progress.total}. Failed: {job.progress.failed}.</p>
    {job.warnings > 0 && <p>Warnings: {job.warnings}</p>}
  </section>;
}
