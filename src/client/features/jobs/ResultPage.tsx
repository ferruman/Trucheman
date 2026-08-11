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
            {results.quality && (
              <div>
                <dt>Automatic checks</dt>
                <dd>
                  {results.quality.scanDefectSegments === 0
                    ? "No suspicious segments"
                    : `${results.quality.scanDefectSegments} suspicious segment(s): ${Object.entries(
                        results.quality.scanDefectsByKind,
                      )
                        .filter(([, value]) => value > 0)
                        .map(([kind, value]) => `${value} ${kind.replace(/_/g, " ")}`)
                        .join(", ")}`}
                </dd>
              </div>
            )}
            {results.quality && (
              <div>
                <dt>Reused from checkpoints</dt>
                <dd>
                  {Object.values(results.quality.cachedCheckpoints).some((value) => value > 0)
                    ? `${Object.entries(results.quality.cachedCheckpoints)
                        .filter(([, value]) => value > 0)
                        .map(([stage, value]) => `${value} ${stage}`)
                        .join(", ")} batch(es) replayed without a provider call`
                    : "Nothing — every stage ran against the provider"}
                </dd>
              </div>
            )}
            {results.quality && results.quality.auditedSegments > 0 && (
              <div>
                <dt>Audit failures</dt>
                <dd>
                  {results.quality.auditErrorSegments === 0
                    ? "None"
                    : `${results.quality.auditErrorSegments} of ${results.quality.auditedSegments} segments (${results.quality.auditErrorsByKind.malformed_json} malformed, ${results.quality.auditErrorsByKind.invalid_issues} invalid)`}
                </dd>
              </div>
            )}
            {results.quality && results.quality.auditedSegments > 0 && (
              <div>
                <dt>Repairs rejected as unsafe</dt>
                <dd>{results.quality.rejectedRepairs}</dd>
              </div>
            )}
            {results.consistency && (
              <div>
                <dt>Consistency resolution</dt>
                <dd>
                  {`${results.consistency.entities} entities (${results.consistency.filteredEntities} filtered), ${results.consistency.resolvedChunks}/${results.consistency.chunks} chunks resolved, ${results.consistency.applied} replacements applied`}
                  {results.consistency.failedChunks > 0 &&
                    `, ${results.consistency.failedChunks} chunk(s) failed`}
                  {results.consistency.ignoredGlossaryEntries > 0 &&
                    `, ${results.consistency.ignoredGlossaryEntries} glossary entry/entries mostly ignored`}
                  {results.consistency.documentWarnings > 0 &&
                    `, ${results.consistency.documentWarnings} quote/ё warning(s)`}
                </dd>
              </div>
            )}
            {results.consistency && results.consistency.errors.length > 0 && (
              <div>
                <dt>Passes that did not run</dt>
                <dd>
                  <ul>
                    {results.consistency.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
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
