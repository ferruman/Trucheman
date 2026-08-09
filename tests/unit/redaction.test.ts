import { describe, expect, it } from "vitest";
import { redact } from "../../src/server/domain/redaction.js";
describe("redaction", () =>
  it("removes credentials from diagnostic strings", () => {
    const result = redact("authorization: Bearer sk-sentinel12345");
    expect(result).not.toContain("sk-sentinel12345");
  }));
