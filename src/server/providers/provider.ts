export type ProviderProfile = {
  name: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  thinking?: "enabled" | "disabled";
};

export type ProviderSegment = { id: string; text: string };
export type ProviderInputSegment =
  ProviderSegment | { id: string; original: string; draft: string };
export type ProviderLanguage = { tag: string; name: string };

export type ProviderRequest = {
  profile: ProviderProfile;
  mode: "translation" | "editing";
  sourceLanguage: ProviderLanguage;
  targetLanguage: ProviderLanguage;
  segments: ProviderInputSegment[];
  instructions?: string;
  glossary?: unknown[];
  promptVersion?: string;
};

export type ProviderResponse = {
  segments: ProviderSegment[];
  usage?: { promptTokens?: number; completionTokens?: number };
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
  ) {
    super(message);
  }
}
