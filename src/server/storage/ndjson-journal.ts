import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileHandle } from "node:fs/promises";

/** A crash mid-append leaves a last line with no newline. Appending after it would glue the next
 * record onto the fragment, and that record would be lost with it. So before appending: a tail that
 * is a whole record only lacks its newline; anything else is cut off and kept in `<path>.torn`. */
async function repairTail(h: FileHandle, path: string): Promise<void> {
  const { size } = await h.stat();
  if (size === 0) return;
  const last = Buffer.alloc(1);
  await h.read(last, 0, 1, size - 1);
  if (last[0] === 0x0a) return;
  const bytes = await readFile(path);
  const cut = bytes.lastIndexOf(0x0a) + 1;
  const tail = bytes.subarray(cut).toString("utf8");
  try {
    JSON.parse(tail);
    await h.writeFile("\n");
    return;
  } catch {
    // torn: falls through
  }
  await appendFile(
    `${path}.torn`,
    `${JSON.stringify({ at: new Date().toISOString(), offset: cut, tail })}\n`,
  );
  await h.truncate(cut);
  console.warn(
    `[trucheman] journal ${path}: cut a torn last record at byte ${cut} (kept in ${path}.torn)`,
  );
}

async function writeLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const h = await open(path, "a+");
  try {
    await repairTail(h, path);
    await h.writeFile(JSON.stringify(value) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
}

/** In-flight append per path. Two concurrent writers whose records interleave mid-write would
 * corrupt both records. Appends are serialized per path. */
const appends = new Map<string, Promise<void>>();

export function appendJournal(path: string, value: unknown): Promise<void> {
  const append = (appends.get(path) ?? Promise.resolve()).then(() => writeLine(path, value));
  // The chain must survive a failed append; the caller still sees the rejection.
  const settled = append.catch(() => {});
  appends.set(path, settled);
  void settled.then(() => {
    if (appends.get(path) === settled) appends.delete(path);
  });
  return append;
}
export async function readJournal<T>(path: string): Promise<T[]> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  const out: T[] = [];
  // A bad line inside the journal (a tear from before appends repaired it) is skipped, not the end:
  // the records after it were written whole and are still the job's progress.
  for (const [i, line] of lines.entries()) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      console.warn(`[trucheman] journal ${path}: skipped unreadable line ${i + 1}`);
    }
  }
  return out;
}
