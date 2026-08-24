import { describe, expect, it } from "vitest";
import {
  applySelectiveRepairs,
  buildQualityAuditSegments,
  buildRepairSegments,
  isActionableQualityIssue,
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
    // Public-domain Alice heading fragmented across separate inline elements.
    const result = applySelectiveRepairs(
      [{ id: "h1", text: "Вниз по кроличьей норе" }],
      [{ id: "h1", text: "Вниз по кроличьей норе норе" }],
    );

    expect(result.segments).toEqual([{ id: "h1", text: "Вниз по кроличьей норе" }]);
    expect(result.rejected).toEqual([
      { id: "h1", reason: "repair duplicates an adjacent fragment" },
    ]);
  });

  it("rejects empty, source-language, quote-breaking, and structure-changing repairs", () => {
    const cases = [
      { edited: "Хороший текст", repaired: "   ", reason: "empty repair" },
      {
        edited: "Море слёз",
        repaired: "Море море of Tears",
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
        edited: "Белый Кролик спешил",
        repaired: "Белый Кролик очень быстро спешил по длинному коридору к Герцогине",
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
    // Public-domain Alice fixture: editing dropped the dialogue and left only the narration,
    // so the correct repair is far longer than the edit but no longer than the source.
    const truncated = "Алиса довольно строго сказала себе:";
    const restored =
      "Алиса довольно строго сказала себе: «Ну же, нет никакого смысла так плакать! " +
      "Советую тебе сейчас же перестать!»";
    const source =
      '"Come, there’s no use in crying like that!" said Alice to herself, rather sharply; ' +
      '"I advise you to leave off this minute!"';

    expect(reviewRepair(truncated, restored)).toBe("repair changes the block structure");
    expect(reviewRepair(truncated, restored, source)).toBe(undefined);

    // Public-domain Botchan fixture: the text to replace *is* the source, and its Russian
    // translation is much longer. See tests/fixtures/NOTICE.md.
    const japanese =
      "教師も生徒も帰ってしまったあとで、一人ぽかんとしているのは随分間が抜けたものだ。";
    const russian =
      "Когда учителя и ученики разошлись, оставаться одному без всякого дела казалось " +
      "до крайности нелепым занятием.";
    expect(russian.length).toBeGreaterThan(japanese.length * 2 + 20);
    expect(reviewRepair(japanese, russian)).toBe(undefined);
    // Still bounded: a repair that runs away is rejected whatever the script.
    expect(reviewRepair(japanese, russian.repeat(6))).toBe("repair changes the block structure");
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

  it("accepts an adjective followed by its comparative as a repair", () => {
    expect(
      reviewRepair(
        "Жизнь у меня была пустая, дальше некуда.",
        "Жизнь у меня была пустая, пустее некуда.",
      ),
    ).toBeUndefined();
  });

  it("quarantines malformed critic output without sending it to repair", () => {
    const inputs = buildQualityAuditSegments(original, initial, edited);
    const findings = parseQualityFindings(inputs, [{ id: "s1", text: "not json" }]);
    expect(findings).toEqual([
      { id: "s1", issues: [], rejectedIssues: 0, auditError: "malformed_json" },
    ]);
    expect(buildRepairSegments(inputs, findings)).toEqual([]);
  });

  it("rejects critic issues whose reasons explicitly conclude there is no defect", () => {
    const inputs = buildQualityAuditSegments(original, initial, edited);
    const findings = parseQualityFindings(inputs, [
      {
        id: "s1",
        text: "",
        issues: [
          {
            span: edited[0].text,
            type: "unnatural_language",
            severity: "high",
            reason: "The phrase is unusual, but it is acceptable. No strong defect.",
          },
          {
            span: edited[0].text,
            type: "glossary_inconsistency",
            severity: "medium",
            reason: "Форма корректна и является допустимым склонением.",
          },
        ],
      },
    ]);

    expect(findings).toEqual([{ id: "s1", issues: [], rejectedIssues: 2 }]);
    expect(buildRepairSegments(inputs, findings)).toEqual([]);
  });

  it("rejects self-contradictory production critic findings", () => {
    const cases = [
      {
        span: "«Дан Коу»",
        reason: "Глоссарий предписывает перевод названия как «Дан Коу».",
      },
      {
        span: "«тридцать восьмой»",
        reason: "В данном сегменте перевод верен оригиналу.",
      },
      {
        span: "гребаный",
        reason: "Оснований для исправления нет, кроме стилевого предпочтения.",
      },
      {
        span: "дарованная ему сила",
        reason: "В тексте отсутствует слово 'сила'.",
      },
      {
        span: "автор сказал: — Смотри!",
        reason: "После двоеточия требуется тире без пробела.",
      },
      {
        span: "не четвертую",
        reason: "Я не уверен. Не буду включать сомнительное замечание.",
      },
      {
        span: "Шангри-Ла",
        reason: "В глоссарии указано «Шангри-Ла», а здесь использовано «Шангри-Ла».",
      },
      {
        span: "— Так ты поможешь мне?",
        reason: "Не хватает закрывающей кавычки после вопросительного знака.",
      },
      {
        span: "Саяка воскликнула: — Это та самая женщина!",
        reason: "Сочетание двоеточия и тире некорректно.",
      },
      {
        span: "Идзаёй-кун",
        reason: "Перед суффиксом опущен дефис.",
      },
      {
        span: "К сожалению.",
        reason: "Фраза слита с предыдущей через запятую.",
      },
    ];

    for (const value of cases) {
      expect(
        isActionableQualityIssue({
          ...value,
          type: "semantic_error",
          severity: "medium",
        }),
        value.reason,
      ).toBe(false);
    }
  });

  it("rejects a language-neutral Roman-numeral heading", () => {
    expect(
      isActionableQualityIssue(
        {
          span: "I",
          type: "context_error",
          severity: "high",
          reason: "The chapter heading was left untranslated.",
        },
        {
          id: "heading",
          original: "I",
          initialTranslation: "I",
          editedTranslation: "I",
        },
      ),
    ).toBe(false);
  });

  it("rejects a high semantic issue whose reason concedes that meaning is preserved", () => {
    expect(
      isActionableQualityIssue({
        span: "из огня да в полымя",
        type: "semantic_error",
        severity: "high",
        reason: "Перевод сохраняет смысл, но кавычки могут быть стилистическим выбором.",
      }),
    ).toBe(false);
  });

  it("keeps an actionable reason even when it distinguishes a correct detail", () => {
    const issue = {
      span: "его тёмные крылья",
      type: "semantic_error" as const,
      severity: "high" as const,
      reason:
        "The adjective agreement is correct, but the pronoun refers to the wrong character and changes the meaning.",
    };

    expect(isActionableQualityIssue(issue)).toBe(true);
  });

  it("rejects critic claims contradicted by the exact source or span", () => {
    const inputs = buildQualityAuditSegments(
      [
        {
          id: "negation",
          text: "There was nothing else to do, so Alice soon began talking again.",
        },
        { id: "quote", text: 'Alice asked, "Où est ma chatte?"' },
        { id: "punctuation", text: "He asked a question." },
        { id: "period", text: "He called it a total loss." },
        { id: "transliteration", text: 'The Mouse asked, "Où est ma chatte?"' },
      ],
      [],
      [
        { id: "negation", text: "Делать больше было нечего, и Алиса вскоре снова заговорила." },
        { id: "quote", text: "Алиса спросила: «Où est ma chatte?»" },
        { id: "punctuation", text: "«Он оставил знак, не так ли?»" },
        { id: "period", text: "«Полная потеря»." },
        { id: "transliteration", text: "Мышь спросила: «Où est ma chatte?»" },
      ],
    );
    const findings = parseQualityFindings(inputs, [
      {
        id: "negation",
        text: "",
        issues: [
          {
            span: "Делать больше было нечего",
            type: "semantic_error",
            severity: "high",
            reason: "Опущено отрицание, поэтому смысл изменён на противоположный.",
          },
        ],
      },
      {
        id: "quote",
        text: "",
        issues: [
          {
            span: "Où est ma chatte?",
            type: "source_language_interference",
            severity: "high",
            reason: "Source word was left inside a translated sentence.",
          },
        ],
      },
      {
        id: "punctuation",
        text: "",
        issues: [
          {
            span: "«Он оставил знак, не так ли?»",
            type: "source_language_interference",
            severity: "medium",
            reason: "Вопросительный знак поставлен после закрывающей кавычки.",
          },
        ],
      },
      {
        id: "period",
        text: "",
        issues: [
          {
            span: "«Полная потеря».",
            type: "semantic_error",
            severity: "medium",
            reason: "The period belongs inside the closing guillemet.",
          },
        ],
      },
      {
        id: "transliteration",
        text: "",
        issues: [
          {
            span: "Où est ma chatte?",
            type: "source_language_interference",
            severity: "medium",
            reason: "Глоссарий требует перевод, а не исходную фразу.",
          },
        ],
      },
    ]);

    expect(findings.map((finding) => finding.issues)).toEqual([[], [], [], [], []]);
    expect(findings.map((finding) => finding.rejectedIssues)).toEqual([1, 1, 1, 1, 1]);
  });
});
