import { resolve, relative, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
export function jobRoot(dataDir: string, id: string): string {
  if (!/^[a-f0-9-]{20,}$/.test(id)) throw new Error("Invalid job id");
  return resolve(dataDir, "jobs", id);
}
export function safeJobPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0"))
    throw new Error("Unsafe path");
  const p = resolve(root, relativePath);
  const r = relative(resolve(root), p);
  if (r.startsWith(".." + sep) || r === ".." || r.startsWith("/"))
    throw new Error("Path escapes job root");
  return p;
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
