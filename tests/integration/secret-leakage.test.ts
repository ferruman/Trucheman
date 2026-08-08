import { describe, expect, it } from "vitest";
import { redact } from "../../src/server/domain/redaction.js";
describe("secret leakage",()=>it("removes provider credentials from persisted diagnostics",()=>expect(redact("api_key=sentinel-value")).not.toContain("sentinel-value")));
