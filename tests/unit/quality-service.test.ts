import { describe, expect, it } from "vitest";
import {
  applySelectiveRepairs,
  buildQualityAuditSegments,
  buildRepairSegments,
  parseQualityFindings,
} from "../../src/server/jobs/quality-service.js";

describe("selective literary quality service", () => {
  const original = [
    { id: "s1", text: "Piecing together of dissociated knowledge" },
    { id: "s2", text: "Already good" },
  ];
  const initial = [
    { id: "s2", text: "Уже хорошо" },
    { id: "s1", text: "Соединение разрознённых знаний" },
  ];
  const edited = [
    { id: "s1", text: "Соединение разрознённых знаний" },
    { id: "s2", text: "И так хорошо" },
  ];

  it("keeps original, initial, and edited translations aligned by segment id", () => {
    expect(buildQualityAuditSegments(original, initial, edited)).toEqual([
      {
        id: "s1",
        original: original[0].text,
        initialTranslation: initial[1].text,
        editedTranslation: edited[0].text,
      },
      {
        id: "s2",
        original: original[1].text,
        initialTranslation: initial[0].text,
        editedTranslation: edited[1].text,
      },
    ]);
  });

  it("repairs only segments with validated medium or high issues", () => {
    const inputs = buildQualityAuditSegments(original, initial, edited);
    const findings = parseQualityFindings(inputs, [
      {
        id: "s1",
        text: JSON.stringify({
          issues: [
            {
              span: "Соединение разрознённых знаний",
              type: "source_language_interference",
              severity: "medium",
              reason: "Source-shaped nominal construction",
            },
            {
              span: "invented span",
              type: "semantic_error",
              severity: "high",
              reason: "Not actually present",
            },
          ],
        }),
      },
      { id: "s2", text: JSON.stringify({ issues: [] }) },
    ]);

    expect(findings[0]).toMatchObject({ rejectedIssues: 1 });
    const repairs = buildRepairSegments(inputs, findings);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      id: "s1",
      contextAfter: "И так хорошо",
      issues: [expect.any(Object)],
    });
    expect(
      applySelectiveRepairs(edited, [{ id: "s1", text: "Когда знания сложатся воедино" }]),
    ).toEqual([
      { id: "s1", text: "Когда знания сложатся воедино" },
      { id: "s2", text: "И так хорошо" },
    ]);
  });

  it("rejects malformed critic output instead of treating it as a clean audit", () => {
    const inputs = buildQualityAuditSegments(original, initial, edited);
    expect(() => parseQualityFindings(inputs, [{ id: "s1", text: "not json" }])).toThrow(
      "malformed JSON",
    );
  });
});
