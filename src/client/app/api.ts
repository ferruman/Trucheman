import type { JobView } from "../../shared/domain/job";

export type JobResults = {
  validation: unknown | null;
  statistics: unknown | null;
  quality: {
    auditedSegments: number;
    flaggedSegments: number;
    auditErrorSegments: number;
    auditErrorsByKind: { malformed_json: number; invalid_issues: number };
    rejectedRepairs: number;
  } | null;
  consistency: {
    entities: number;
    filteredEntities: number;
    chunks: number;
    resolvedChunks: number;
    failedChunks: number;
    decisions: number;
    applied: number;
    mechanicalApplied: number;
    glossaryAligned: number;
  } | null;
  usage: {
    version: 1;
    generatedAt: string;
    totals: UsageNumbers;
    breakdown: Array<
      UsageNumbers & {
        stage: "translation" | "editing" | "audit" | "repair" | "consistency";
        profile: string;
        endpoint: string;
        model: string;
      }
    >;
  };
};

type UsageNumbers = {
  requests: number;
  requestsWithUsage: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type AcceptedResponse = { accepted: boolean };

async function responseError(response: Response, fallback: string): Promise<Error> {
  const problem = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return new Error(typeof problem?.detail === "string" ? problem.detail : fallback);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) throw await responseError(response, `Request failed (HTTP ${response.status})`);
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export const api = {
  list: (init?: RequestInit) => request<JobView[]>("/jobs", init),
  get: (id: string, init?: RequestInit) => request<JobView>(`/jobs/${id}`, init),
  create: (body: unknown) =>
    request<JobView>("/jobs", { method: "POST", body: JSON.stringify(body) }),
  settings: () => request<unknown>("/settings"),
};

export async function uploadSource(id: string, file: File): Promise<void> {
  const response = await fetch(`/api/jobs/${id}/source`, {
    method: "PUT",
    headers: { "content-type": "application/epub+zip" },
    body: file,
  });
  if (!response.ok) throw await responseError(response, `Upload failed (HTTP ${response.status})`);
}

export const jobActions = {
  configure: (id: string, body: unknown) =>
    request<JobView>(`/jobs/${id}/config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  analyze: (id: string) => request<JobView>(`/jobs/${id}/analyze`, { method: "POST" }),
  start: (id: string) => request<JobView>(`/jobs/${id}/start`, { method: "POST" }),
  pause: (id: string) => request<{ status: string }>(`/jobs/${id}/pause`, { method: "POST" }),
  resume: (id: string) => request<{ status: string }>(`/jobs/${id}/resume`, { method: "POST" }),
  retry: (id: string) => request<AcceptedResponse>(`/jobs/${id}/retry`, { method: "POST" }),
  invalidate: (id: string, scopes: string[]) =>
    request<{ ok: boolean }>(`/jobs/${id}/invalidate`, {
      method: "POST",
      body: JSON.stringify({ scopes }),
    }),
  results: (id: string) => request<JobResults>(`/jobs/${id}/results`),
  rebuild: (id: string) => request<AcceptedResponse>(`/jobs/${id}/rebuild`, { method: "POST" }),
  remove: (id: string) => request<void>(`/jobs/${id}`, { method: "DELETE" }),
};
