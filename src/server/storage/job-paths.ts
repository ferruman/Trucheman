import { isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function jobRoot(dataDir: string, id: string): string {
  if (!JOB_ID_PATTERN.test(id)) throw new Error("Invalid job id");
  return safeJobPath(resolve(dataDir, "jobs"), id);
}
export function safeJobPath(root: string, relativePath: string): string {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  )
    throw new Error("Unsafe path");
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Path escapes job root");
  }
  return resolvedPath;
}
export function newJobId(): string {
  return randomUUID();
}
export const jobFiles = {
  state: "job.json",
  source: "source.epub",
  events: "events.ndjson",
  drafts: "drafts.ndjson",
  edits: "edits.ndjson",
} as const;
export function child(root: string, name: keyof typeof jobFiles): string {
  return safeJobPath(root, jobFiles[name]);
}
