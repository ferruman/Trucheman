import { useState } from "react";
import type { JobEvent } from "../../app/job-events";

const MAX_VISIBLE_EVENTS = 250;

function levelFor(event: JobEvent) {
  if (/(failed|error)/i.test(event.type)) return "error";
  if (/(warning|retry)/i.test(event.type)) return "warning";
  return "info";
}

function detailsFor(event: JobEvent) {
  if (!event.data || Object.keys(event.data).length === 0) return "";
  return Object.entries(event.data)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

export function JobLogPanel({ events }: { events: JobEvent[] }) {
  const [copied, setCopied] = useState(false);
  const visible = events.slice(-MAX_VISIBLE_EVENTS);

  async function copyLogs() {
    const transcript = visible
      .map((event) => {
        const details = detailsFor(event);
        return `[${event.timestamp}] ${event.type}: ${event.message}${details ? ` — ${details}` : ""}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="job-log-panel" aria-labelledby="log-heading">
      <div className="panel-heading log-heading">
        <div>
          <span className="section-label">Live transcript</span>
          <h2 id="log-heading">Execution log</h2>
        </div>
        <button
          className="secondary log-copy"
          type="button"
          onClick={() => void copyLogs()}
          disabled={visible.length === 0}
        >
          {copied ? "Copied" : "Copy log"}
        </button>
      </div>
      <p className="log-hint">
        Events are retained after a refresh. Copy this transcript when reporting a problem.
      </p>
      {visible.length === 0 ? (
        <p className="log-empty" role="status">
          Waiting for the first execution event.
        </p>
      ) : (
        <ol className="job-log" aria-live="polite" aria-relevant="additions text">
          {visible.map((event) => {
            const details = detailsFor(event);
            return (
              <li className={`log-entry log-${levelFor(event)}`} key={event.id}>
                <time dateTime={event.timestamp}>
                  {new Date(event.timestamp).toLocaleTimeString()}
                </time>
                <div>
                  <strong>{event.message}</strong>
                  <span>{event.type}</span>
                  {details && <code>{details}</code>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
