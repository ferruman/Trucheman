import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function runOptionalEpubCheck(path: string, timeout = 30000) {
  try {
    const result = await exec("epubcheck", [path], { timeout });
    return { available: true, ok: true, output: result.stdout.slice(-4000) };
  } catch (error: any) {
    if (error.code === "ENOENT")
      return { available: false, ok: true, output: "EPUBCheck is not installed." };
    return {
      available: true,
      ok: false,
      output: String(error.stdout ?? error.stderr ?? "EPUBCheck failed").slice(-4000),
    };
  }
}
