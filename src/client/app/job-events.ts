export type JobEvent = {
  id: number;
  type: string;
  timestamp: string;
  message: string;
  data?: Record<string, unknown>;
};

type JobEventHandlers = {
  onEvent: (event: JobEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
};

export function parseJobEvent(event: MessageEvent<string>): JobEvent | null {
  try {
    const value: unknown = JSON.parse(event.data);
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isInteger((value as JobEvent).id) ||
      typeof (value as JobEvent).type !== "string" ||
      typeof (value as JobEvent).timestamp !== "string" ||
      typeof (value as JobEvent).message !== "string"
    )
      return null;
    return value as JobEvent;
  } catch {
    return null;
  }
}

export function subscribeToJobEvents(id: string, handlers: JobEventHandlers): () => void {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  const listener = (event: MessageEvent<string>) => {
    const parsed = parseJobEvent(event);
    if (parsed) handlers.onEvent(parsed);
  };

  source.onopen = () => handlers.onConnectionChange?.(true);
  source.onerror = () => handlers.onConnectionChange?.(false);
  source.onmessage = listener;

  return () => {
    source.close();
  };
}
