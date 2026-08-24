import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JobResults } from "../../src/client/app/api.js";
import { ResultPage } from "../../src/client/features/jobs/ResultPage.js";

const usage: JobResults["usage"] = {
  version: 1,
  generatedAt: "2026-08-13T00:00:00.000Z",
  totals: {
    requests: 0,
    requestsWithUsage: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  },
  breakdown: [],
};

function render(epubCheck: JobResults["epubCheck"]) {
  return renderToStaticMarkup(
    <ResultPage
      id="job-1"
      results={{
        validation: {},
        statistics: {},
        quality: null,
        consistency: null,
        usage,
        epubCheck,
      }}
      error=""
      busyAction=""
      onRetry={vi.fn()}
      onRebuild={vi.fn()}
      onRepairEpub={vi.fn()}
    />,
  );
}

describe("ResultPage EPUBCheck report", () => {
  it("shows the separate conformance log and repair action for errors", () => {
    const markup = render({
      version: 1,
      checkedAt: "2026-08-13T00:00:00.000Z",
      available: true,
      ok: false,
      counts: { fatal: 0, error: 1, warning: 0, info: 0 },
      messages: [{ level: "error", code: "RSC-005", text: "attribute not allowed" }],
      omittedMessages: 0,
    });

    expect(markup).toContain("Conformance log");
    expect(markup).toContain("RSC-005");
    expect(markup).toContain("Repair EPUB");
  });

  it("does not offer repair after EPUBCheck passes", () => {
    const markup = render({
      version: 1,
      checkedAt: "2026-08-13T00:00:00.000Z",
      available: true,
      ok: true,
      counts: { fatal: 0, error: 0, warning: 0, info: 0 },
      messages: [],
      omittedMessages: 0,
    });

    expect(markup).toContain("Passed with no findings");
    expect(markup).not.toContain("Repair EPUB");
  });
});
