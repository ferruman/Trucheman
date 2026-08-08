import { useCallback, useEffect, useState } from "react";
import type { JobView } from "../../../shared/domain/job";
import { api } from "../../app/api";

export function JobsPage() {
  const [jobs, setJobs] = useState<JobView[]>();
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setError("");
    try {
      setJobs(await api.list({ signal }));
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "Unable to load jobs");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return <section>
    <h2>Jobs</h2>
    {jobs === undefined && !error && <p role="status">Loading jobs…</p>}
    {error && <div role="alert"><p>Jobs could not be loaded: {error}</p><button type="button" onClick={() => void load()}>Try again</button></div>}
    {jobs?.length === 0 && !error && <p>No books yet. <a href="/new">Create a job</a>.</p>}
    {jobs && jobs.length > 0 && <ul>{jobs.map(job => <li key={job.id}>
      <a href={`/jobs/${job.id}`}>{job.title}</a> — {job.sourceLanguage} → {job.targetLanguage} — {job.status}
    </li>)}</ul>}
  </section>;
}
