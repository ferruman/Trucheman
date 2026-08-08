import { providerResultSchema } from "../../shared/api/schemas.js";
import type { ProviderInputSegment, ProviderResponse, ProviderSegment } from "./provider.js";

export function validateProviderResponse(
  response: ProviderResponse,
  expected: ProviderInputSegment[],
): ProviderResponse {
  const parsed = providerResultSchema.parse({ segments: response.segments });
  const ids = expected.map((item) => item.id);
  const got = parsed.segments.map((item) => item.id);
  if (
    got.length !== ids.length ||
    new Set(got).size !== got.length ||
    got.some((id, index) => id !== ids[index])
  ) {
    throw new Error("Provider response IDs do not exactly match the request");
  }
  if (response.finishReason && response.finishReason !== "stop") {
    throw new Error("Provider response was truncated");
  }
  return { ...response, segments: parsed.segments };
}

function comparisonText(segment: ProviderInputSegment): string {
  return "text" in segment ? segment.text : segment.draft;
}

export function qualityWarnings(
  expected: ProviderInputSegment[],
  actual: ProviderSegment[],
): string[] {
  const warnings: string[] = [];
  for (const expectedSegment of expected) {
    const actualSegment = actual.find((item) => item.id === expectedSegment.id);
    const sourceText = comparisonText(expectedSegment);
    if (actualSegment && actualSegment.text.length > Math.max(1000, sourceText.length * 4)) {
      warnings.push(`Suspicious length for ${expectedSegment.id}`);
    }
    if (actualSegment?.text.includes("As an AI")) {
      warnings.push(`Service boilerplate in ${expectedSegment.id}`);
    }
  }
  return warnings;
}
