export type LanguageSegment = { text: string };

export type LanguageDocument = {
  id: string;
  editedSegments: LanguageSegment[];
};

export type LanguageAuditDocument = {
  id: string;
  text: string;
  lang?: string;
  xmlLang?: string;
};

export type LanguageAudit = {
  warnings: string[];
  checks: Record<string, unknown>;
};

export type LanguageConsistencyDiagnostics = {
  documents: Array<{
    id: string;
    quotes: {
      opening: number;
      closing: number;
      straight: number;
      unmatchedOpenings: number;
      unmatchedClosings: number;
      continuations: number;
      balanced: boolean;
      hybrid: string[];
      duplicated: number;
    };
    yo: {
      variants: Array<{ key: string; variants: string[] }>;
      segmentsWithYo: number;
      segmentsWithoutYo: number;
      longestWithoutYoChars: number;
      possibleDrift: boolean;
    };
  }>;
  warningCount: number;
};

export type TargetLanguageCapabilities = {
  /** Appended to the system prompt as target-language rules. */
  promptRules?: string;
  /** Structured style hints sent next to the segments in the prompt input. */
  promptStyle?: Record<string, string>;
  /** Case endings used by deterministic glossary and entity alignment. */
  nameEndings?: string[];
  /** Dominant writing system expected in ordinary translated prose. */
  script?: "latin" | "cyrillic" | "cjk";
  /** Deterministic whole-book typography cleanup. */
  normalizeConsistency?: (documents: LanguageDocument[]) => number;
  diagnoseConsistency?: (documents: LanguageDocument[]) => LanguageConsistencyDiagnostics;
  /** Whether a source digit is represented by words in the target text. */
  isNumberWrittenOut?: (value: string, text: string) => boolean;
  /** Target-language-only EPUB checks and optional linguistic analysis. */
  auditEpub?: (documents: LanguageAuditDocument[]) => LanguageAudit;
  loadAgreementFixes?: (text: string) => Promise<unknown[]>;
};

export type SourceLanguageCapabilities = {
  promptRules?: string;
  batchCharBudget?: number;
  batchSegmentCap?: number;
  preparePackage?: (document: Document, staging: string) => Promise<boolean>;
  normalizeContent?: (document: Document, readings: Map<string, string>) => boolean;
};

export type LanguageModule = {
  tag: string;
  source?: SourceLanguageCapabilities;
  target?: TargetLanguageCapabilities;
};

export type LanguagePairModule = {
  source: string;
  target: string;
  promptRules: string;
};
import type { Document } from "@xmldom/xmldom";
