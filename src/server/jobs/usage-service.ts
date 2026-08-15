import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  LanguageModelProvider,
  ProviderRequest,
  ProviderResponse,
} from "../providers/provider.js";
import { ProviderError } from "../providers/provider.js";
import { redact } from "../domain/redaction.js";
import { atomicJson } from "../storage/atomic-file.js";
import { appendJournal, readJournal } from "../storage/ndjson-journal.js";

export type UsageStage = ProviderRequest["mode"];
/** Cached checkpoints never reach the provider, so they never produce a usage record. */
export type UsageOutcome = "ok" | "invalid_response" | "timeout" | "configuration" | "error";

export type UsageRecord = {
  outcome?: UsageOutcome;
  /**
   * Why the call was rejected, for anything but `ok`. A retry that succeeds throws the reason
   * away, so without this the only record of 39 invalid translation responses across seven
   * books was the count — and a count cannot tell truncation from a broken contract.
   */
  detail?: string;
  version: 1;
  recordedAt: string;
  callId: string;
  /** One execution of a job. Prevents a deliberate rerun from looking like a retry. */
  runId?: string;
  requestId?: string;
  stage: UsageStage;
  operation?: string;
  profile: string;
  endpoint: string;
  model: string;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type UsageBreakdown = {
  stage: UsageStage;
  profile: string;
  endpoint: string;
  model: string;
  requests: number;
  /** Distinct batches asked for, as opposed to HTTP attempts spent on them. */
  logicalOperations: number;
  /** Batches that needed more than one attempt. Zero failed batches is the goal, not zero retries. */
  retriedOperations: number;
  requestsWithUsage: number;
  failedRequests: number;
  invalidResponses: number;
  timeouts: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UsageReport = {
  version: 2;
  generatedAt: string;
  totals: Omit<UsageBreakdown, "stage" | "profile" | "endpoint" | "model">;
  breakdown: UsageBreakdown[];
};

const STAGE_ORDER: UsageStage[] = ["translation", "editing", "audit", "repair", "consistency"];

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function usageRecord(
  request: ProviderRequest,
  response: ProviderResponse,
  runId: string,
  outcome: UsageOutcome = "ok",
  detail?: string,
): UsageRecord {
  const promptTokens = token(response.usage?.promptTokens);
  const cachedPromptTokens = token(response.usage?.cachedPromptTokens);
  const completionTokens = token(response.usage?.completionTokens);
  const totalTokens =
    promptTokens === null && completionTokens === null
      ? null
      : (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    version: 1,
    outcome,
    // The message names the batch's own text often enough — a rejected span, a returned
    // field list — that it goes through the same redaction as anything else leaving a run.
    detail: detail ? redact(detail).slice(0, 300) : undefined,
    recordedAt: new Date().toISOString(),
    callId: randomUUID(),
    runId,
    requestId: response.requestId,
    stage: request.mode,
    // Stable across retries of the same batch and distinct between batches, so counting
    // distinct operations separates "how many batches did we ask for" from "how many HTTP
    // attempts did that cost". Reading only the request count made 14 survived timeouts
    // look like 14 lost batches.
    operation: request.segments[0]?.id,
    profile: request.profile.name,
    endpoint: request.profile.endpoint,
    model: request.profile.model,
    promptTokens,
    cachedPromptTokens,
    completionTokens,
    totalTokens,
  };
}

function emptyNumbers() {
  return {
    requests: 0,
    logicalOperations: 0,
    retriedOperations: 0,
    requestsWithUsage: 0,
    failedRequests: 0,
    invalidResponses: 0,
    timeouts: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

export function buildUsageReport(records: UsageRecord[]): UsageReport {
  const groups = new Map<string, UsageBreakdown>();
  const attemptsPerOperation = new Map<string, Map<string, number>>();
  for (const record of records) {
    const key = [record.stage, record.profile, record.endpoint, record.model].join("\u0000");
    const row = groups.get(key) ?? {
      stage: record.stage,
      profile: record.profile,
      endpoint: record.endpoint,
      model: record.model,
      ...emptyNumbers(),
    };
    // A record written before operations were identified has no id to group by; counting it
    // as its own operation degrades to "logical == requests" rather than to a silent zero.
    const operation = record.operation ?? record.callId;
    const counts = attemptsPerOperation.get(key) ?? new Map<string, number>();
    counts.set(operation, (counts.get(operation) ?? 0) + 1);
    attemptsPerOperation.set(key, counts);
    row.requests++;
    if (record.totalTokens !== null) row.requestsWithUsage++;
    if (record.outcome && record.outcome !== "ok") {
      row.failedRequests++;
      if (record.outcome === "invalid_response") row.invalidResponses++;
      if (record.outcome === "timeout") row.timeouts++;
    }
    row.promptTokens += record.promptTokens ?? 0;
    row.cachedPromptTokens += record.cachedPromptTokens ?? 0;
    row.completionTokens += record.completionTokens ?? 0;
    row.totalTokens += record.totalTokens ?? 0;
    groups.set(key, row);
  }
  for (const [key, row] of groups) {
    const counts = attemptsPerOperation.get(key);
    if (!counts) continue;
    row.logicalOperations = counts.size;
    row.retriedOperations = [...counts.values()].filter((attempts) => attempts > 1).length;
  }
  const breakdown = [...groups.values()].sort(
    (a, b) =>
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.model.localeCompare(b.model),
  );
  const totals = breakdown.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      logicalOperations: sum.logicalOperations + row.logicalOperations,
      retriedOperations: sum.retriedOperations + row.retriedOperations,
      requestsWithUsage: sum.requestsWithUsage + row.requestsWithUsage,
      failedRequests: sum.failedRequests + row.failedRequests,
      invalidResponses: sum.invalidResponses + row.invalidResponses,
      timeouts: sum.timeouts + row.timeouts,
      promptTokens: sum.promptTokens + row.promptTokens,
      cachedPromptTokens: sum.cachedPromptTokens + row.cachedPromptTokens,
      completionTokens: sum.completionTokens + row.completionTokens,
      totalTokens: sum.totalTokens + row.totalTokens,
    }),
    emptyNumbers(),
  );
  return { version: 2, generatedAt: new Date().toISOString(), totals, breakdown };
}

export async function readUsageReport(root: string, runId?: string): Promise<UsageReport> {
  const records = await readJournal<UsageRecord>(join(root, "usage.ndjson"));
  // Journals remain an append-only cost history, while the published report describes the
  // latest execution. Previously a second run doubled tokens and made every reused operation
  // look like a retry because both executions shared the same operation ids.
  const selectedRunId =
    runId ?? [...records].reverse().find((record) => record.runId !== undefined)?.runId;
  return buildUsageReport(
    selectedRunId ? records.filter((record) => record.runId === selectedRunId) : records,
  );
}

async function recordUsage(
  root: string,
  request: ProviderRequest,
  response: ProviderResponse,
  runId: string,
  outcome: UsageOutcome = "ok",
  detail?: string,
) {
  await appendJournal(
    join(root, "usage.ndjson"),
    usageRecord(request, response, runId, outcome, detail),
  );
  const report = await readUsageReport(root, runId);
  await atomicJson(join(root, "usage-report.json"), report);
}

export class UsageTrackingProvider implements LanguageModelProvider {
  private writes = Promise.resolve();

  constructor(
    private readonly provider: LanguageModelProvider,
    private readonly root: string,
    private readonly runId = randomUUID(),
  ) {}

  async complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    try {
      const response = await this.provider.complete(request, signal);
      this.writes = this.writes.then(() => recordUsage(this.root, request, response, this.runId));
      await this.writes;
      return response;
    } catch (error) {
      // Failed and invalid attempts still cost tokens and still have to show up in the report.
      if (error instanceof ProviderError) {
        const outcome: UsageOutcome =
          error.kind === "invalid_response"
            ? "invalid_response"
            : error.kind === "configuration"
              ? "configuration"
              : /timed out/i.test(error.message)
                ? "timeout"
                : "error";
        this.writes = this.writes.then(() =>
          recordUsage(
            this.root,
            request,
            { segments: [], usage: error.usage, requestId: error.requestId },
            this.runId,
            outcome,
            error.message,
          ),
        );
        await this.writes;
      }
      throw error;
    }
  }
}
