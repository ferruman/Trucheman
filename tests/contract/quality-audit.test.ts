import { describe, expect, it } from "vitest";
import { parseAuditSegments } from "../../src/server/providers/audit-contract.js";
import {
  auditBatch,
  buildQualityAuditSegments,
  buildRepairSegments,
  parseQualityFindings,
} from "../../src/server/jobs/quality-service.js";
import { ProviderError, type LanguageModelProvider } from "../../src/server/providers/provider.js";

const ids = ["s1", "s2"];
const issue = {
  span: "Привет",
  type: "unnatural_language" as const,
  severity: "medium" as const,
  reason: "Too casual",
};

describe("quality audit contract", () => {
  it("accepts a well-formed structured audit response", () => {
    expect(
      parseAuditSegments(
        {
          segments: [
            { id: "s1", issues: [issue] },
            { id: "s2", issues: [] },
          ],
        },
        ids,
      ),
    ).toEqual([
      { id: "s1", issues: [issue] },
      { id: "s2", issues: [] },
    ]);
  });

  it("marks a malformed envelope without inventing findings", () => {
    expect(parseAuditSegments({ notSegments: true }, ids)).toEqual([
      { id: "s1", issues: [], auditError: "malformed_json" },
      { id: "s2", issues: [], auditError: "malformed_json" },
    ]);
  });

  it("ignores an unknown segment id and reports the missing one", () => {
    const parsed = parseAuditSegments(
      {
        segments: [
          { id: "s1", issues: [] },
          { id: "unknown", issues: [] },
        ],
      },
      ids,
    );
    expect(parsed[0]).toEqual({ id: "s1", issues: [] });
    expect(parsed[1]).toEqual({ id: "s2", issues: [], auditError: "invalid_issues" });
  });

  it("rejects a duplicated segment id rather than picking one arbitrarily", () => {
    const parsed = parseAuditSegments(
      {
        segments: [
          { id: "s1", issues: [issue] },
          { id: "s1", issues: [] },
          { id: "s2", issues: [] },
        ],
      },
      ids,
    );
    expect(parsed[0].auditError).toBe("invalid_issues");
    expect(parsed[1]).toEqual({ id: "s2", issues: [] });
  });

  it("treats an empty issue list as a clean segment", () => {
    expect(parseAuditSegments({ segments: [{ id: "s1", issues: [] }] }, ["s1"])).toEqual([
      { id: "s1", issues: [] },
    ]);
  });

  it("keeps good segments when one segment's issues are unusable", () => {
    const parsed = parseAuditSegments(
      {
        segments: [
          { id: "s1", issues: [{ ...issue, severity: "catastrophic" }] },
          { id: "s2", issues: [issue] },
        ],
      },
      ids,
    );
    expect(parsed[0]).toEqual({ id: "s1", issues: [], auditError: "invalid_issues" });
    expect(parsed[1]).toEqual({ id: "s2", issues: [issue] });
  });

  it("records an audit error instead of failing the book when the critic gives up", async () => {
    let calls = 0;
    const provider: LanguageModelProvider = {
      async complete() {
        calls++;
        throw new ProviderError(
          "invalid_response",
          "Provider returned malformed structured output",
        );
      },
    };
    const segments = buildQualityAuditSegments(
      [{ id: "s1", text: "Hello" }],
      [{ id: "s1", text: "Привет" }],
      [{ id: "s1", text: "Привет" }],
    );

    const result = await auditBatch(
      provider,
      { name: "critic", endpoint: "local", model: "critic" },
      segments,
      {
        sourceLanguage: { tag: "en", name: "English" },
        targetLanguage: { tag: "ru", name: "Russian" },
      },
    );

    expect(calls).toBeGreaterThan(1); // retried before giving up
    expect(result.findings).toEqual([
      { id: "s1", issues: [], rejectedIssues: 0, auditError: "malformed_json" },
    ]);
    expect(buildRepairSegments(segments, result.findings)).toEqual([]);
  });

  it("prefers structured issues over a legacy stringified journal entry", () => {
    const inputs = buildQualityAuditSegments(
      [{ id: "s1", text: "Hello" }],
      [{ id: "s1", text: "Привет" }],
      [{ id: "s1", text: "Привет" }],
    );
    expect(
      parseQualityFindings(inputs, [{ id: "s1", text: "unparseable", issues: [issue] }]),
    ).toEqual([{ id: "s1", issues: [issue], rejectedIssues: 0 }]);
  });
});
