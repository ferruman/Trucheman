import { JOB_STAGES, type JobView } from "../../../shared/domain/job";

const STAGE_LABELS: Record<(typeof JOB_STAGES)[number], string> = {
  import: "Import",
  analysis: "Inspect",
  translation: "Translate",
  editing: "Edit",
  building: "Build",
  validation: "Validate",
  complete: "Complete",
};

export function ProgressPanel({ job }: { job: JobView }) {
  const currentStage = JOB_STAGES.indexOf(job.stage);
  const translatedPercent = job.progress.total === 0 ? 0 : Math.round((job.progress.translated / job.progress.total) * 100);
  const editedPercent = job.progress.total === 0 ? 0 : Math.round((job.progress.edited / job.progress.total) * 100);

  return <section className="progress-panel" aria-label="Progress">
    <ol className="pipeline" aria-label="Translation pipeline">
      {JOB_STAGES.map((stage, index) => <li
        className={index < currentStage ? "complete" : index === currentStage ? "current" : "pending"}
        key={stage}
        aria-current={index === currentStage ? "step" : undefined}
      >
        <span className="stage-index">{String(index + 1).padStart(2, "0")}</span>
        <span className="stage-copy">
          <strong>{STAGE_LABELS[stage]}</strong>
          <small>{index < currentStage ? "Done" : index === currentStage ? job.status.replace("_", " ") : "Waiting"}</small>
        </span>
      </li>)}
    </ol>
    <div className="stage-summary">
      <div>
        <span className="section-label">Current stage</span>
        <h3>{STAGE_LABELS[job.stage]}</h3>
      </div>
      <span className={`status-token status-${job.status}`}>{job.status.replace("_", " ")}</span>
    </div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">Status: {job.status}. Stage: {job.stage}.</p>
    {job.currentDocument && <p className="current-document"><span>Current document</span><code>{job.currentDocument}</code></p>}
    <div className="metric-grid">
      <div><span>Translated</span><strong>{job.progress.translated.toLocaleString()}</strong><small>{translatedPercent}% of {job.progress.total.toLocaleString()}</small></div>
      <div><span>Edited</span><strong>{job.progress.edited.toLocaleString()}</strong><small>{editedPercent}% of {job.progress.total.toLocaleString()}</small></div>
      <div><span>Failed</span><strong>{job.progress.failed.toLocaleString()}</strong><small>segments</small></div>
      <div><span>Warnings</span><strong>{job.warnings.toLocaleString()}</strong><small>require review</small></div>
    </div>
    <div className="progress-track" aria-label={`${translatedPercent}% translated`}>
      <span style={{ width: `${translatedPercent}%` }}/>
    </div>
  </section>;
}
