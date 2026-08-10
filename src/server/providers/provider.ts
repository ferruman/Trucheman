import type { QualityIssue } from "./audit-contract.js";

export type ProviderProfile = {
  name: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  thinking?: "enabled" | "disabled";
  promptVersion?: string;
};

/**
 * `issues` is the structured audit payload. It is authoritative for audit responses;
 * `text` then only carries a canonical serialization written by this code (never by the
 * model) so journals, checkpoints, and the shared response validator stay unchanged.
 */
export type ProviderSegment = { id: string; text: string; issues?: QualityIssue[] };
export type ProviderEditingInputSegment = { id: string; original: string; draft: string };
export type ProviderAuditInputSegment = {
  id: string;
  original: string;
  initialTranslation: string;
  editedTranslation: string;
};
export type ProviderRepairInputSegment = ProviderAuditInputSegment & {
  issues: Array<{ span: string; type: string; severity: "medium" | "high"; reason: string }>;
  contextBefore?: string;
  contextAfter?: string;
};
export type ProviderInputSegment =
  | ProviderSegment
  | ProviderEditingInputSegment
  | ProviderAuditInputSegment
  | ProviderRepairInputSegment;
export type ProviderLanguage = { tag: string; name: string };

export type ProviderRequest = {
  profile: ProviderProfile;
  mode: "translation" | "editing" | "audit" | "repair" | "consistency";
  sourceLanguage: ProviderLanguage;
  targetLanguage: ProviderLanguage;
  segments: ProviderInputSegment[];
  instructions?: string;
  glossary?: unknown[];
  promptVersion?: string;
};

export type ProviderResponse = {
  segments: ProviderSegment[];
  usage?: {
    promptTokens?: number;
    cachedPromptTokens?: number;
    completionTokens?: number;
  };
  finishReason?: string;
  requestId?: string;
};

export interface LanguageModelProvider {
  complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse>;
}

export class ProviderError extends Error {
  constructor(
    public readonly kind: "temporary" | "configuration" | "invalid_response",
    message: string,
    public readonly status?: number,
    public readonly usage?: ProviderResponse["usage"],
    public readonly requestId?: string,
    public readonly partialResponse?: ProviderResponse,
  ) {
    super(message);
  }
}
