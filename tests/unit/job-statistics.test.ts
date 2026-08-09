import { describe, expect, it } from "vitest";
import { aggregateStatistics } from "../../src/server/jobs/statistics.js";
describe("job statistics", () =>
  it("aggregates usage, retries, elapsed time, and price", () => {
    const result = aggregateStatistics(
      [
        {
          promptTokens: 100,
          completionTokens: 50,
          attempts: 2,
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:00:01Z",
        },
      ],
      { input: 1, output: 2 },
    );
    expect(result.retries).toBe(1);
    expect(result.elapsedMs).toBe(1000);
    expect(result.costEstimate).toBeCloseTo(0.0002);
  }));
