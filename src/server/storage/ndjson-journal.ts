import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
async function writeLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const h = await open(path, "a");
  try {
    await h.writeFile(JSON.stringify(value) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
}

/** In-flight append per path. `readJournal` stops at the first unparseable line, so two
 * concurrent writers whose records get split mid-write would silently truncate the journal
 * from that point on — every checkpoint after the tear lost. Appends are serialized per path. */
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
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      break;
    }
  }
  return out;
}
