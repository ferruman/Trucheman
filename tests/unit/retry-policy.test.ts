import { describe, expect, it } from "vitest";
import { retryDecision } from "../../src/server/providers/retry-policy.js";
describe("retry policy", () => {
  it("retries temporary failures with a bound", () => {
    const decision = retryDecision({ kind: "temporary", status: 429 }, 0, 3, 1000);
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThanOrEqual(800);
  });
  it("does not retry permanent configuration failures", () =>
    expect(retryDecision({ kind: "configuration", status: 401 }, 0).retry).toBe(false));
  it("rides out a longer outage than it gives a model that breaks the contract", () => {
    // A connection drop resolves on its own; an invalid response repeats until the caller
    // halves the batch, so only the transport failure gets the extra attempts.
    expect(retryDecision({ kind: "temporary" }, 3, 3).retry).toBe(true);
    expect(retryDecision({ kind: "temporary" }, 4, 3).retry).toBe(true);
    expect(retryDecision({ kind: "temporary" }, 5, 3).retry).toBe(false);
    expect(retryDecision({ kind: "invalid_response" }, 3, 3).retry).toBe(false);
  });
  it("caps the backoff of the last transport attempt", () =>
    expect(retryDecision({ kind: "temporary" }, 4, 3).delayMs).toBeLessThanOrEqual(30000 * 1.2));
});
