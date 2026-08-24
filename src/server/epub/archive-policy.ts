import { posix } from "node:path";
export type ArchiveEntry = {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod?: number;
  encrypted?: boolean;
  externalFileAttributes?: number;
};
export type ArchiveLimits = {
  maxEntries: number;
  maxCompressedBytes: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
};
export const defaultArchiveLimits: ArchiveLimits = {
  maxEntries: 10000,
  maxCompressedBytes: 100 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
};
export function normalizeEntryName(name: string): string {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  )
    throw new Error("Unsafe archive path");
  const n = posix.normalize(name);
  if (n === "." || n.startsWith("../") || n === ".." || n.includes("/../"))
    throw new Error("Archive path traversal");
  return n;
}
export function validateArchiveEntries(
  entries: ArchiveEntry[],
  limits = defaultArchiveLimits,
): string[] {
  if (entries.length > limits.maxEntries) throw new Error("Archive has too many entries");
  let compressed = 0,
    expanded = 0;
  const seen = new Set<string>(),
    names: string[] = [];
  for (const e of entries) {
    const n = normalizeEntryName(e.fileName);
    if (seen.has(n)) throw new Error("Duplicate archive path");
    seen.add(n);
    if (e.encrypted) throw new Error("Encrypted archives are not supported");
    if (e.compressionMethod !== undefined && ![0, 8].includes(e.compressionMethod))
      throw new Error("Unsupported compression");
    if (e.uncompressedSize > limits.maxEntryBytes) throw new Error("Archive entry is too large");
    compressed += e.compressedSize;
    expanded += e.uncompressedSize;
    if (compressed > limits.maxCompressedBytes || expanded > limits.maxExpandedBytes)
      throw new Error("Archive exceeds size budget");
    names.push(n);
  }
  return names;
}
