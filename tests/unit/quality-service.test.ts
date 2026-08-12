import { describe, expect, it } from "vitest";
import {
  applySelectiveRepairs,
  buildQualityAuditSegments,
  buildRepairSegments,
  parseQualityFindings,
  reviewRepair,
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
    ).toEqual({
      segments: [
        { id: "s1", text: "Когда знания сложатся воедино" },
        { id: "s2", text: "И так хорошо" },
      ],
      rejected: [],
    });
  });

  it("rejects a repair that duplicates a fragment of the block it repaired", () => {
    // The production regression: repairing the fragmented heading "In / the / Desert".
    const result = applySelectiveRepairs(
      [{ id: "h1", text: "В пустыне" }],
      [{ id: "h1", text: "В пустыне пустыня" }],
    );

    expect(result.segments).toEqual([{ id: "h1", text: "В пустыне" }]);
    expect(result.rejected).toEqual([
      { id: "h1", reason: "repair duplicates an adjacent fragment" },
    ]);
  });

  it("rejects empty, source-language, quote-breaking, and structure-changing repairs", () => {
    const cases = [
      { edited: "Хороший текст", repaired: "   ", reason: "empty repair" },
      {
        edited: "Из страны дальних солнц",
        repaired: "Из земли Земля из the Farther Suns",
        reason: "repair duplicates an adjacent fragment",
      },
      {
        edited: "Он сказал так",
        repaired: "Он сказал the word",
        reason: "repair introduces source-language residue",
      },
      {
        edited: "Он сказал «да» тихо",
        repaired: "Он сказал «да тихо",
        reason: "repair unbalances guillemets",
      },
      {
        edited: "Ночные пташки",
        repaired: "Ночные пташки, которые летают в темноте над безмолвным городом каждую ночь",
        reason: "repair changes the block structure",
      },
    ];

    for (const { edited: text, repaired, reason } of cases) {
      expect(reviewRepair(text, repaired), `${text} → ${repaired}`).toBe(reason);
      expect(applySelectiveRepairs([{ id: "s", text }], [{ id: "s", text: repaired }])).toEqual({
        segments: [{ id: "s", text }],
        rejected: [{ id: "s", reason }],
      });
    }
  });

  it("accepts a repair that restores a block the editor truncated", () => {
    // The real shape of the defect: editing dropped the dialogue and left only the narration,
    // so the correct repair is far longer than the edit but no longer than the source.
    const truncated = "Помолчав, Дезидра сказала:";
    const restored =
      "Помолчав, Дезидра сказала: — Он тебя накажет, верно? Может, даже убьёт, " +
      "если не приведёшь меня обратно. Разве не так? Ты играешь с огнём, Крис.";
    const source =
      "After a long moment, Desidra said, \"He'll punish you, right? Maybe kill you if you " +
      "don't bring me back. Isn't that correct? You're playing a dangerous game with me, Chris.\"";

    expect(reviewRepair(truncated, restored)).toBe("repair changes the block structure");
    expect(reviewRepair(truncated, restored, source)).toBe(undefined);
    expect(
      applySelectiveRepairs(
        [{ id: "s", text: truncated }],
        [{ id: "s", text: restored }],
        [
          {
            id: "s",
            original: source,
            initialTranslation: "",
            editedTranslation: truncated,
            issues: [],
          },
        ],
      ),
    ).toEqual({ segments: [{ id: "s", text: restored }], rejected: [] });
  });

  it("accepts a genuine repair and never changes segment ids or count", () => {
    const result = applySelectiveRepairs(edited, [
      { id: "s1", text: "Когда знания сложатся воедино" },
      { id: "unknown", text: "не должен появиться" },
    ]);

    expect(reviewRepair("Соединение разрознённых знаний", "Когда знания сложатся воедино")).toBe(
      undefined,
    );
    expect(result.segments.map((segment) => segment.id)).toEqual(["s1", "s2"]);
    expect(result.rejected).toEqual([]);
  });

  it("quarantines malformed critic output without sending it to repair", () => {
    const inputs = buildQualityAuditSegments(original, initial, edited);
    const findings = parseQualityFindings(inputs, [{ id: "s1", text: "not json" }]);
    expect(findings).toEqual([
      { id: "s1", issues: [], rejectedIssues: 0, auditError: "malformed_json" },
    ]);
    expect(buildRepairSegments(inputs, findings)).toEqual([]);
  });
});
