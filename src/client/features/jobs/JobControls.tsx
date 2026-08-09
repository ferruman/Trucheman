import type { JobStatus } from "../../../shared/domain/job";

type Props = {
  status: JobStatus;
  busyAction: string;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onInvalidate: () => void;
  onDelete: () => void;
};

export function JobControls({
  status,
  busyAction,
  onStart,
  onPause,
  onResume,
  onRetry,
  onInvalidate,
  onDelete,
}: Props) {
  const busy = busyAction !== "";
  const deletable = status !== "running" && status !== "stopping" && status !== "analyzing";
  return (
    <div className="actions" aria-label="Job controls">
      {(status === "ready" || status === "completed" || status === "failed") && (
        <button disabled={busy} type="button" onClick={onStart}>
          {busyAction === "start"
            ? "Starting…"
            : status === "completed"
              ? "Run again with current provider"
              : "Start translation"}
        </button>
      )}
      {status === "running" && (
        <button disabled={busy} type="button" onClick={onPause}>
          {busyAction === "pause" ? "Pausing…" : "Pause"}
        </button>
      )}
      {status === "stopping" && (
        <button disabled type="button">
          Pausing…
        </button>
      )}
      {status === "paused" && (
        <button disabled={busy} type="button" onClick={onResume}>
          {busyAction === "resume" ? "Resuming…" : "Resume"}
        </button>
      )}
      {status === "needs_attention" && (
        <button disabled={busy} type="button" onClick={onRetry}>
          {busyAction === "retry" ? "Retrying…" : "Retry failed work"}
        </button>
      )}
      {(status === "completed" || status === "failed" || status === "needs_attention") && (
        <button disabled={busy} className="secondary" type="button" onClick={onInvalidate}>
          Invalidate completed work…
        </button>
      )}
      {deletable && (
        <button disabled={busy} className="danger" type="button" onClick={onDelete}>
          Delete job
        </button>
      )}
    </div>
  );
}
