import { useCallback, useEffect, useState } from "react";
import type { JobView } from "../../../shared/domain/job";
import { api, jobActions } from "../../app/api";
import { DeleteJobDialog } from "./DeleteJobDialog";

export function JobsPage() {
  const [jobs, setJobs] = useState<JobView[]>();
  const [error, setError] = useState("");
  const [jobToDelete, setJobToDelete] = useState<JobView>();
  const [deleting, setDeleting] = useState(false);

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

  async function deleteJob() {
    if (!jobToDelete || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await jobActions.remove(jobToDelete.id);
      setJobs((current) => current?.filter((job) => job.id !== jobToDelete.id));
      setJobToDelete(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete the job");
      setJobToDelete(undefined);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="page jobs-page">
      <header className="page-header">
        <div>
          <span className="section-label">Local queue</span>
          <h1>Translation jobs</h1>
        </div>
        <a className="button-link" href="/new">
          New book
        </a>
      </header>
      {jobs === undefined && !error && <p role="status">Loading jobs…</p>}
      {error && (
        <div role="alert">
          <p>Jobs could not be loaded: {error}</p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {jobs?.length === 0 && !error && (
        <div className="empty-state">
          <span className="section-label">Queue empty</span>
          <h2>No translation jobs yet</h2>
          <p>Import an EPUB to inspect its structure and prepare the first run.</p>
          <a className="button-link" href="/new">
            Create a job
          </a>
        </div>
      )}
      {jobs && jobs.length > 0 && (
        <div className="job-list-wrap">
          <div className="job-list-head" aria-hidden="true">
            <span>Book</span>
            <span>Languages</span>
            <span>Status</span>
            <span>Updated</span>
            <span>Actions</span>
          </div>
          <ul className="job-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <a href={`/jobs/${job.id}`}>
                  <span className="job-title">
                    {job.title}
                    <small>{job.id}</small>
                  </span>
                  <span className="language-pair">
                    {job.sourceLanguage.toUpperCase()} <b aria-hidden="true">→</b>{" "}
                    {job.targetLanguage.toUpperCase()}
                  </span>
                  <span className={`status-token status-${job.status}`}>
                    {job.status.replace("_", " ")}
                  </span>
                  <time dateTime={job.updatedAt}>{new Date(job.updatedAt).toLocaleString()}</time>
                </a>
                <button
                  className="danger job-delete"
                  type="button"
                  onClick={() => setJobToDelete(job)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <DeleteJobDialog
        open={Boolean(jobToDelete)}
        busy={deleting}
        onCancel={() => setJobToDelete(undefined)}
        onConfirm={() => void deleteJob()}
      />
    </section>
  );
}
