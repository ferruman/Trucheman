import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JobControls } from "../../src/client/features/jobs/JobControls.js";

function render(status: Parameters<typeof JobControls>[0]["status"]) {
  return renderToStaticMarkup(
    <JobControls
      status={status}
      busyAction=""
      onStart={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onRetry={vi.fn()}
      onInvalidate={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("JobControls", () => {
  it("offers checkpoint-aware retry for a failed job", () => {
    const markup = render("failed");
    expect(markup).toContain("Retry failed work");
    expect(markup).not.toContain("Start translation");
  });

  it("keeps the initial start action for a ready job", () => {
    const markup = render("ready");
    expect(markup).toContain("Start translation");
    expect(markup).not.toContain("Retry failed work");
  });
});
