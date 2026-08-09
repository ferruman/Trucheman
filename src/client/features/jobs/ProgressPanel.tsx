import { type JobStage, type JobView } from "../../../shared/domain/job";

const STAGE_LABELS: Record<JobStage, string> = {
  import: "Import",
  analysis: "Inspect",
  translation: "Translate",
  editing: "Edit",
  audit: "Audit",
  repair: "Repair",
  building: "Build",
  validation: "Validate",
  complete: "Complete",
};

const PIPELINE = [
  { id: "import", label: "Import" },
  { id: "analysis", label: "Inspect" },
  { id: "batch-cycle", label: "Translate + edit" },
  { id: "building", label: "Build" },
  { id: "validation", label: "Validate" },
  { id: "complete", label: "Complete" },
] as const;

function pipelineIndex(stage: JobStage) {
  if (["translation", "editing", "audit", "repair"].includes(stage)) return 2;
  if (stage === "building") return 3;
  if (stage === "validation") return 4;
  if (stage === "complete") return 5;
  return stage === "analysis" ? 1 : 0;
}

export function ProgressPanel({ job }: { job: JobView }) {
  const currentStage = pipelineIndex(job.stage);
  const translatedPercent =
    job.progress.total === 0 ? 0 : Math.round((job.progress.translated / job.progress.total) * 100);
  const editedPercent =
    job.progress.total === 0 ? 0 : Math.round((job.progress.edited / job.progress.total) * 100);

  return (
    <section className="progress-panel" aria-label="Progress">
      <ol className="pipeline" aria-label="Translation pipeline">
        {PIPELINE.map((stage, index) => (
          <li
            className={
              index < currentStage ? "complete" : index === currentStage ? "current" : "pending"
            }
            key={stage.id}
            aria-current={index === currentStage ? "step" : undefined}
          >
            <span className="stage-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="stage-copy">
              <strong>{stage.label}</strong>
              <small>
                {index < currentStage
                  ? "Done"
                  : index === currentStage
                    ? stage.id === "batch-cycle"
                      ? `${STAGE_LABELS[job.stage]} each batch`
                      : job.status.replace("_", " ")
                    : "Waiting"}
              </small>
            </span>
          </li>
        ))}
      </ol>
      <div className="stage-summary">
        <div>
          <span className="section-label">Current stage</span>
          <h3>
            {["translation", "editing", "audit", "repair"].includes(job.stage)
              ? job.qualityMode === "high"
                ? "Translation, editing, and quality cycle"
                : "Translation and editing cycle"
              : STAGE_LABELS[job.stage]}
          </h3>
        </div>
        <span className={`status-token status-${job.status}`}>{job.status.replace("_", " ")}</span>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Status: {job.status}. Stage: {job.stage}.
      </p>
      {["translation", "editing", "audit", "repair"].includes(job.stage) && (
        <p className="batch-cycle-note">
          <span>Batch cycle</span>
          <strong>
            {job.qualityMode === "high"
              ? "Translate → edit → audit → selective repair"
              : "Translate → edit"}
          </strong>
          <small>Repeats for each batch · now {STAGE_LABELS[job.stage].toLowerCase()}</small>
        </p>
      )}
      {job.currentDocument && (
        <p className="current-document">
          <span>Current document</span>
          <code>{job.currentDocument}</code>
        </p>
      )}
      <div className="metric-grid">
        <div>
          <span>Translated</span>
          <strong>{job.progress.translated.toLocaleString()}</strong>
          <small>
            {translatedPercent}% of {job.progress.total.toLocaleString()}
          </small>
        </div>
        <div>
          <span>Edited</span>
          <strong>{job.progress.edited.toLocaleString()}</strong>
          <small>
            {editedPercent}% of {job.progress.total.toLocaleString()}
          </small>
        </div>
        <div>
          <span>Failed</span>
          <strong>{job.progress.failed.toLocaleString()}</strong>
          <small>segments</small>
        </div>
        <div>
          <span>Warnings</span>
          <strong>{job.warnings.toLocaleString()}</strong>
          <small>require review</small>
        </div>
      </div>
      <div className="progress-track" aria-label={`${translatedPercent}% translated`}>
        <span style={{ width: `${translatedPercent}%` }} />
      </div>
    </section>
  );
}
