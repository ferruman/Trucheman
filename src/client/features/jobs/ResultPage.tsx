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
  return <section aria-labelledby="result-heading">
    <h3 id="result-heading">Result</h3>
    {!results && !error && <p role="status">Loading validation results…</p>}
    {error && <div role="alert"><p>Results could not be loaded: {error}</p><button className="secondary" type="button" onClick={onRetry}>Try again</button></div>}
    {results && <>
      <p>Validation report: {results.validation === null ? "not available" : "available"}.</p>
      <p>Statistics: {results.statistics === null ? "not available" : "available"}.</p>
      <div className="actions">
        <a className="button-link" href={`/api/jobs/${id}/download`}>Download translated EPUB</a>
        <button className="secondary" disabled={busy} type="button" onClick={onRebuild}>{busy ? "Rebuilding…" : "Rebuild output"}</button>
      </div>
    </>}
  </section>;
}
