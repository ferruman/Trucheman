import { describe, expect, it } from "vitest";
import { retryDecision } from "../../src/server/providers/retry-policy.js";
describe("retry policy",()=>{it("retries temporary failures with a bound",()=>{const decision=retryDecision({kind:"temporary",status:429},0,3,1000);expect(decision.retry).toBe(true);expect(decision.delayMs).toBeGreaterThanOrEqual(800);});it("does not retry permanent configuration failures",()=>expect(retryDecision({kind:"configuration",status:401},0).retry).toBe(false));});
