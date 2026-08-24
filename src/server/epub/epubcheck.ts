import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicJson, atomicWrite } from "../storage/atomic-file.js";

const exec = promisify(execFile);
const MAX_REPORTED_LINES = 20;
const MAX_REPORT_MESSAGES = 250;

export type EpubCheckMessage = {
  level: "fatal" | "error" | "warning" | "info";
  code: string | null;
  text: string;
};

export type EpubCheckReport = {
  version: 1;
  checkedAt: string | null;
  available: boolean;
  ok: boolean;
  counts: { fatal: number; error: number; warning: number; info: number };
  messages: EpubCheckMessage[];
  omittedMessages: number;
};

export type EpubCheckResult = EpubCheckReport & { output: string };

/** Parse EPUBCheck's human-readable output into a stable API/UI contract. */
export function parseEpubCheckOutput(
  output: string,
  options: { available?: boolean; processOk?: boolean; checkedAt?: string | null } = {},
): EpubCheckReport {
  const available = options.available ?? true;
  const allMessages: EpubCheckMessage[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    const match = /^(FATAL|ERROR|WARNING|INFO)(?:\(([^)]+)\))?:\s*(.+)$/i.exec(line);
    if (!match) continue;
    allMessages.push({
      level: match[1].toLowerCase() as EpubCheckMessage["level"],
      code: match[2] ?? null,
      text: match[3],
    });
  }

  const summary =
    /Messages:\s*(\d+)\s+fatals?\s*\/\s*(\d+)\s+errors?\s*\/\s*(\d+)\s+warnings?\s*\/\s*(\d+)\s+infos?/i.exec(
      output,
    );
  const countLevel = (level: EpubCheckMessage["level"]) =>
    allMessages.filter((message) => message.level === level).length;
  const counts = summary
    ? {
        fatal: Number(summary[1]),
        error: Number(summary[2]),
        warning: Number(summary[3]),
        info: Number(summary[4]),
      }
    : {
        fatal: countLevel("fatal"),
        error: countLevel("error"),
        warning: countLevel("warning"),
        info: countLevel("info"),
      };
  const processSucceeded = options.processOk ?? true;
  const completed = Boolean(summary) || processSucceeded;
  return {
    version: 1,
    checkedAt: options.checkedAt ?? null,
    available,
    ok: !available || (completed && counts.fatal === 0 && counts.error === 0),
    counts,
    messages: allMessages.slice(0, MAX_REPORT_MESSAGES),
    omittedMessages: Math.max(0, allMessages.length - MAX_REPORT_MESSAGES),
  };
}

/**
 * The ERROR/FATAL lines of an EPUBCheck report, capped. Kept for the pipeline's compact warning
 * summary; the complete structured report is persisted separately for the results screen.
 */
export function epubCheckErrors(output: string): string[] {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(ERROR|FATAL)\b/.test(line));
  if (lines.length <= MAX_REPORTED_LINES) return lines;
  return [
    ...lines.slice(0, MAX_REPORTED_LINES),
    `EPUBCheck reported ${lines.length - MAX_REPORTED_LINES} further problems; see epubcheck.txt`,
  ];
}

export async function runOptionalEpubCheck(
  path: string,
  timeout = 30000,
): Promise<EpubCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await exec("epubcheck", [path], { timeout, maxBuffer: 4 * 1024 * 1024 });
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    return { ...parseEpubCheckOutput(output, { checkedAt, processOk: true }), output };
  } catch (error) {
    const failure = error as { code?: string; stdout?: string; stderr?: string };
    if (failure.code === "ENOENT") {
      const output = "EPUBCheck is not installed.";
      return {
        ...parseEpubCheckOutput(output, { available: false, checkedAt, processOk: true }),
        output,
      };
    }
    // EPUBCheck writes findings to stderr and normally keeps only its summary on stdout.
    const output =
      [failure.stderr, failure.stdout].filter(Boolean).join("\n") || "EPUBCheck failed";
    return {
      ...parseEpubCheckOutput(output, { checkedAt, processOk: false }),
      output,
    };
  }
}

export async function persistEpubCheckResult(root: string, result: EpubCheckResult): Promise<void> {
  const { output, ...report } = result;
  await atomicJson(join(root, "epubcheck-report.json"), report);
  if (result.available) await atomicWrite(join(root, "epubcheck.txt"), output);
  else await rm(join(root, "epubcheck.txt"), { force: true });
}

export async function readEpubCheckReport(root: string): Promise<EpubCheckReport | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, "epubcheck-report.json"), "utf8"));
    if (parsed?.version === 1 && typeof parsed.available === "boolean")
      return parsed as EpubCheckReport;
  } catch {
    // Fall through to the legacy text report written by earlier versions.
  }
  try {
    return parseEpubCheckOutput(await readFile(join(root, "epubcheck.txt"), "utf8"), {
      processOk: false,
    });
  } catch {
    return null;
  }
}
