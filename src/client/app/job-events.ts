const JOB_EVENT_TYPES = [
  "job.created",
  "job.state_changed",
  "analysis.progress",
  "batch.started",
  "batch.retrying",
  "batch.completed",
  "batch.failed",
  "validation.completed",
  "build.completed",
  "recovery.paused",
] as const;

type JobEventHandlers = {
  onEvent: (event: MessageEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
};

export function subscribeToJobEvents(id: string, handlers: JobEventHandlers): () => void {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  const listener = (event: Event) => handlers.onEvent(event as MessageEvent);

  source.onopen = () => handlers.onConnectionChange?.(true);
  source.onerror = () => handlers.onConnectionChange?.(false);
  source.onmessage = handlers.onEvent;
  for (const type of JOB_EVENT_TYPES) source.addEventListener(type, listener);

  return () => {
    for (const type of JOB_EVENT_TYPES) source.removeEventListener(type, listener);
    source.close();
  };
}
