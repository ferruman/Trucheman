import { useCallback, useEffect, useRef, useState } from "react";
import type { JobView } from "../../../shared/domain/job";
import { api, jobActions, type JobResults } from "../../app/api";
import { subscribeToJobEvents } from "../../app/job-events";
import { InvalidationDialog } from "./InvalidationDialog";
import { JobControls } from "./JobControls";
import { ProgressPanel } from "./ProgressPanel";
import { ResultPage } from "./ResultPage";

export function JobPage({ id }: { id: string }) {
  const [job, setJob] = useState<JobView>();
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [connected, setConnected] = useState(true);
  const [invalidationOpen, setInvalidationOpen] = useState(false);
  const [results, setResults] = useState<JobResults>();
  const [resultsError, setResultsError] = useState("");
  const refreshVersion = useRef(0);
  const actionLock = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++refreshVersion.current;
    try {
      const value = await api.get(id, { signal });
      if (version !== refreshVersion.current || signal?.aborted) return;
      setJob(value);
      setLoadError("");
    } catch (cause) {
      if (signal?.aborted || version !== refreshVersion.current) return;
      setLoadError(cause instanceof Error ? cause.message : "Unable to load the job");
    }
  }, [id]);

  const loadResults = useCallback(async () => {
    setResultsError("");
    try {
      setResults(await jobActions.results(id));
    } catch (cause) {
      setResultsError(cause instanceof Error ? cause.message : "Unable to load results");
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const unsubscribe = subscribeToJobEvents(id, {
      onEvent: () => void refresh(controller.signal),
      onConnectionChange: setConnected,
    });
    const timer = window.setInterval(() => void refresh(controller.signal), 5000);
    return () => {
      controller.abort();
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [id, refresh]);

  useEffect(() => {
    if (job?.status === "completed") void loadResults();
  }, [job?.status, loadResults]);

  async function act(name: string, action: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusyAction(name);
    setActionError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : `Unable to ${name}`);
    } finally {
      actionLock.current = false;
      setBusyAction("");
    }
  }

  async function invalidate() {
    await act("invalidate", () => jobActions.invalidate(id, ["translations", "edits", "output"]));
    setInvalidationOpen(false);
  }

  if (!job && loadError) return <section><h2>Job unavailable</h2><div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Try again</button></div></section>;
  if (!job) return <section><h2>Loading job</h2><p role="status">Loading job…</p></section>;

  return <section>
    <h2>{job.title}</h2>
    <ProgressPanel job={job}/>
    {!connected && <p className="muted" role="status">Live updates are reconnecting. Periodic refresh remains active.</p>}
    {loadError && <div role="alert"><p>Latest status could not be refreshed: {loadError}</p><button className="secondary" type="button" onClick={() => void refresh()}>Try again</button></div>}
    <JobControls
      status={job.status}
      busyAction={busyAction}
      onStart={() => void act("start", () => jobActions.start(id))}
      onPause={() => void act("pause", () => jobActions.pause(id))}
      onResume={() => void act("resume", () => jobActions.resume(id))}
      onRetry={() => void act("retry", () => jobActions.retry(id))}
      onInvalidate={() => setInvalidationOpen(true)}
    />
    {actionError && <p role="alert">{actionError}</p>}
    {job.status === "completed" && <ResultPage id={id} results={results} error={resultsError} busy={busyAction === "rebuild"} onRetry={() => void loadResults()} onRebuild={() => void act("rebuild", () => jobActions.rebuild(id))}/>}
    <InvalidationDialog open={invalidationOpen} busy={busyAction === "invalidate"} onCancel={() => setInvalidationOpen(false)} onConfirm={() => void invalidate()}/>
  </section>;
}
