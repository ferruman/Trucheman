import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const MAX_REPORTED_LINES = 20;

/**
 * The ERROR/FATAL lines of an EPUBCheck report, capped. Warnings are already covered by the
 * in-house validator and the consistency audit; the full report is kept on disk regardless.
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

export async function runOptionalEpubCheck(path: string, timeout = 30000) {
  try {
    const result = await exec("epubcheck", [path], { timeout });
    return { available: true, ok: true, output: result.stdout.slice(-4000) };
  } catch (error) {
    const failure = error as { code?: string; stdout?: string; stderr?: string };
    if (failure.code === "ENOENT")
      return { available: false, ok: true, output: "EPUBCheck is not installed." };
    return {
      available: true,
      ok: false,
      output: String(failure.stdout ?? failure.stderr ?? "EPUBCheck failed").slice(-4000),
    };
  }
}
