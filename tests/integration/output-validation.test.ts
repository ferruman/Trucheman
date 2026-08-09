import { describe, expect, it } from "vitest";
import { publicValidationReport } from "../../src/server/epub/validation-report.js";
describe("output validation", () =>
  it("exposes safe validation evidence", () =>
    expect(
      publicValidationReport({ ok: true, errors: [], warnings: ["minor"], documents: 1 }),
    ).toEqual({ ok: true, errors: [], warnings: ["minor"], documents: 1 })));
