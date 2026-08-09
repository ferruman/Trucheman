import type { JobResults } from "../../app/api";

type Props = {
  id: string;
  results?: JobResults;
  error: string;
  busy: boolean;
  onRetry: () => void;
  onRebuild: () => void;
};

export function ResultPage({ id, results, error, busy, onRetry, onRebuild }: Props) {
  return (
    <section className="result-panel" aria-labelledby="result-heading">
      <div className="panel-heading">
        <span className="section-label">Output</span>
        <h2 id="result-heading">Translated EPUB ready</h2>
      </div>
      {!results && !error && <p role="status">Loading validation results…</p>}
      {error && (
        <div role="alert">
          <p>Results could not be loaded: {error}</p>
          <button className="secondary" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {results && (
        <>
          <dl className="result-checks">
            <div>
              <dt>Validation report</dt>
              <dd>{results.validation === null ? "Not available" : "Available"}</dd>
            </div>
            <div>
              <dt>Translation statistics</dt>
              <dd>{results.statistics === null ? "Not available" : "Available"}</dd>
            </div>
          </dl>
          <div className="actions">
            <a className="button-link" href={`/api/jobs/${id}/download`}>
              Download translated EPUB
            </a>
            <button className="secondary" disabled={busy} type="button" onClick={onRebuild}>
              {busy ? "Rebuilding…" : "Rebuild output"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
