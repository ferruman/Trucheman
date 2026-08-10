import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  LanguageModelProvider,
  ProviderRequest,
  ProviderResponse,
} from "../providers/provider.js";
import { ProviderError } from "../providers/provider.js";
import { atomicJson } from "../storage/atomic-file.js";
import { appendJournal, readJournal } from "../storage/ndjson-journal.js";

export type UsageStage = ProviderRequest["mode"];
/** Cached checkpoints never reach the provider, so they never produce a usage record. */
export type UsageOutcome = "ok" | "invalid_response" | "timeout" | "configuration" | "error";

export type UsageRecord = {
  outcome?: UsageOutcome;
  version: 1;
  recordedAt: string;
  callId: string;
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
  version: 1;
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
  outcome: UsageOutcome = "ok",
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
    recordedAt: new Date().toISOString(),
    callId: randomUUID(),
    requestId: response.requestId,
    stage: request.mode,
    operation:
      request.mode === "consistency" && request.segments.length === 1
        ? request.segments[0].id
        : undefined,
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
  for (const record of records) {
    const key = [record.stage, record.profile, record.endpoint, record.model].join("\u0000");
    const row = groups.get(key) ?? {
      stage: record.stage,
      profile: record.profile,
      endpoint: record.endpoint,
      model: record.model,
      ...emptyNumbers(),
    };
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
  const breakdown = [...groups.values()].sort(
    (a, b) =>
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.model.localeCompare(b.model),
  );
  const totals = breakdown.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
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
  return { version: 1, generatedAt: new Date().toISOString(), totals, breakdown };
}

export async function readUsageReport(root: string): Promise<UsageReport> {
  return buildUsageReport(await readJournal<UsageRecord>(join(root, "usage.ndjson")));
}

async function recordUsage(
  root: string,
  request: ProviderRequest,
  response: ProviderResponse,
  outcome: UsageOutcome = "ok",
) {
  await appendJournal(join(root, "usage.ndjson"), usageRecord(request, response, outcome));
  const report = await readUsageReport(root);
  await atomicJson(join(root, "usage-report.json"), report);
}

export class UsageTrackingProvider implements LanguageModelProvider {
  private writes = Promise.resolve();

  constructor(
    private readonly provider: LanguageModelProvider,
    private readonly root: string,
  ) {}

  async complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    try {
      const response = await this.provider.complete(request, signal);
      this.writes = this.writes.then(() => recordUsage(this.root, request, response));
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
            outcome,
          ),
        );
        await this.writes;
      }
      throw error;
    }
  }
}
