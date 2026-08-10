import type { LanguageModelProvider, ProviderRequest, ProviderResponse } from "./provider.js";

function inputText(segment: ProviderRequest["segments"][number]): string {
  if ("text" in segment) return segment.text;
  if ("editedTranslation" in segment) return segment.editedTranslation;
  return segment.draft;
}

export class FakeProvider implements LanguageModelProvider {
  requests: ProviderRequest[] = [];

  constructor(
    private transform: (text: string, mode: ProviderRequest["mode"]) => string = (text, mode) => {
      if (mode === "translation") return `[translated] ${text}`;
      if (mode === "audit") return JSON.stringify({ issues: [] });
      return text;
    },
  ) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(structuredClone(request));
    return {
      segments: request.segments.map((segment) => {
        const text = this.transform(inputText(segment), request.mode);
        if (request.mode !== "audit") return { id: segment.id, text };
        const issues = (() => {
          try {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed?.issues) ? parsed.issues : [];
          } catch {
            return [];
          }
        })();
        return { id: segment.id, text, issues };
      }),
      finishReason: "stop",
      usage: {
        promptTokens: request.segments.reduce(
          (total, segment) => total + inputText(segment).length,
          0,
        ),
        completionTokens: request.segments.reduce(
          (total, segment) => total + inputText(segment).length,
          0,
        ),
      },
    };
  }
}
