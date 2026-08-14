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
  busyAction: string;
  onRetry: () => void;
  onRebuild: () => void;
  onRepairEpub: () => void;
};

function epubCheckSummary(report: NonNullable<JobResults["epubCheck"]>) {
  if (!report.available) return "Not installed — optional check skipped";
  if (report.ok && report.counts.warning === 0) return "Passed with no findings";
  if (report.ok) return `Passed with ${report.counts.warning} warning(s)`;
  return `${report.counts.fatal + report.counts.error} error(s), ${report.counts.warning} warning(s)`;
}

export function ResultPage({
  id,
  results,
  error,
  busyAction,
  onRetry,
  onRebuild,
  onRepairEpub,
}: Props) {
  const busy = busyAction !== "";
  const epubNeedsRepair =
    results?.epubCheck?.available &&
    (!results.epubCheck.ok || results.epubCheck.counts.warning > 0);
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
            <div>
              <dt>EPUB conformance</dt>
              <dd>{results.epubCheck ? epubCheckSummary(results.epubCheck) : "Not checked yet"}</dd>
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
          {results.epubCheck && results.epubCheck.available && (
            <section
              className={`epubcheck-section ${results.epubCheck.ok ? "is-valid" : "has-errors"}`}
              aria-labelledby="epubcheck-heading"
            >
              <div className="epubcheck-heading">
                <div>
                  <span className="section-label">EPUBCheck</span>
                  <h3 id="epubcheck-heading">Conformance log</h3>
                </div>
                <p role="status">{epubCheckSummary(results.epubCheck)}</p>
              </div>
              {!results.epubCheck.ok && (
                <p className="epubcheck-guidance">
                  The translated book is still downloadable. Repair works on a separate copy and
                  keeps the current EPUB unless the rebuilt candidate passes validation.
                </p>
              )}
              {results.epubCheck.messages.length > 0 ? (
                <ol className="epubcheck-log" aria-label="EPUBCheck findings">
                  {results.epubCheck.messages.map((message, index) => (
                    <li className={`epubcheck-${message.level}`} key={`${message.code}:${index}`}>
                      <strong>{message.level}</strong>
                      {message.code && <code>{message.code}</code>}
                      <span>{message.text}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="epubcheck-empty">No EPUBCheck messages were reported.</p>
              )}
              {results.epubCheck.omittedMessages > 0 && (
                <p className="epubcheck-omitted">
                  {results.epubCheck.omittedMessages} additional message(s) omitted from this view.
                </p>
              )}
            </section>
          )}
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
              {busyAction === "rebuild" ? "Rebuilding…" : "Rebuild output"}
            </button>
            {epubNeedsRepair && (
              <button disabled={busy} type="button" onClick={onRepairEpub}>
                {busyAction === "repair EPUB" ? "Repairing EPUB…" : "Repair EPUB"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
