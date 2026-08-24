import { describe, expect, it } from "vitest";
import { parseJobEvent } from "../../src/client/app/job-events.js";

describe("job event parsing", () => {
  it("accepts a stored event from the SSE stream", () => {
    const event = new MessageEvent("message", {
      data: JSON.stringify({
        id: 4,
        type: "failed",
        timestamp: "2026-08-09T10:00:00.000Z",
        message: "Translation failed",
        data: { error: "Provider timeout" },
      }),
    });
    expect(parseJobEvent(event)).toMatchObject({
      id: 4,
      type: "failed",
      data: { error: "Provider timeout" },
    });
  });

  it("ignores malformed SSE payloads", () => {
    expect(parseJobEvent(new MessageEvent("message", { data: "not json" }))).toBeNull();
  });
});
