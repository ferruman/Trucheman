import type { JobResults } from "../../app/api";

const USAGE_STAGE_LABELS: Record<JobResults["usage"]["breakdown"][number]["stage"], string> = {
  translation: "Translation",
  editing: "Literary editing",
  audit: "Critic audit",
  repair: "Selective repair",
  consistency: "Book consistency",
};

function tokens(value: number) {
  return value.toLocaleString();
}

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
          <section className="usage-section" aria-labelledby="usage-heading">
            <div className="usage-heading">
              <div>
                <span className="section-label">Model usage</span>
                <h3 id="usage-heading">Tokens by pipeline stage</h3>
              </div>
              <p>
                <strong>{tokens(results.usage.totals.totalTokens)}</strong> tokens across{" "}
                {tokens(results.usage.totals.requests)} requests
              </p>
            </div>
            {results.usage.breakdown.length === 0 ? (
              <p className="usage-empty">No provider usage was recorded for this job.</p>
            ) : (
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">Model</th>
                      <th scope="col">Requests</th>
                      <th scope="col">Input</th>
                      <th scope="col">Cached input</th>
                      <th scope="col">Output</th>
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.usage.breakdown.map((row) => (
                      <tr key={`${row.stage}:${row.profile}:${row.endpoint}:${row.model}`}>
                        <th scope="row">{USAGE_STAGE_LABELS[row.stage]}</th>
                        <td>
                          <code>{row.model}</code>
                          <small>{row.profile}</small>
                        </td>
                        <td>{tokens(row.requests)}</td>
                        <td>{tokens(row.promptTokens)}</td>
                        <td>{tokens(row.cachedPromptTokens)}</td>
                        <td>{tokens(row.completionTokens)}</td>
                        <td>{tokens(row.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={2}>
                        Total
                      </th>
                      <td>{tokens(results.usage.totals.requests)}</td>
                      <td>{tokens(results.usage.totals.promptTokens)}</td>
                      <td>{tokens(results.usage.totals.cachedPromptTokens)}</td>
                      <td>{tokens(results.usage.totals.completionTokens)}</td>
                      <td>{tokens(results.usage.totals.totalTokens)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {results.usage.totals.requestsWithUsage < results.usage.totals.requests && (
              <p className="usage-note">
                Token counts were returned for {tokens(results.usage.totals.requestsWithUsage)} of{" "}
                {tokens(results.usage.totals.requests)} requests.
              </p>
            )}
          </section>
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
