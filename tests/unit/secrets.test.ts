import { describe, expect, it } from "vitest";
import { redact } from "../../src/server/domain/redaction.js";
describe("secret boundaries",()=>it("does not retain sentinel credentials in diagnostics",()=>expect(redact("Bearer sk-sentinel-secret")).not.toContain("sentinel")));
