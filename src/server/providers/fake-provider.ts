import type { LanguageModelProvider, ProviderRequest, ProviderResponse } from "./provider.js";

function inputText(segment: ProviderRequest["segments"][number]): string {
  return "text" in segment ? segment.text : segment.draft;
}

export class FakeProvider implements LanguageModelProvider {
  requests: ProviderRequest[] = [];

  constructor(
    private transform: (text: string, mode: ProviderRequest["mode"]) => string = (text, mode) =>
      mode === "translation" ? `[translated] ${text}` : text,
  ) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(structuredClone(request));
    return {
      segments: request.segments.map((segment) => ({
        id: segment.id,
        text: this.transform(inputText(segment), request.mode),
      })),
      finishReason: "stop",
      usage: {
        promptTokens: request.segments.reduce((total, segment) => total + inputText(segment).length, 0),
        completionTokens: request.segments.reduce((total, segment) => total + inputText(segment).length, 0),
      },
    };
  }
}
