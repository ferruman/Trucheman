import yauzl, { type Entry } from "yauzl";
import { mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { defaultArchiveLimits, validateArchiveEntries } from "./archive-policy.js";

export async function extractEpub(source: string, destination: string): Promise<string[]> {
  await mkdir(destination, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      source,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, opened) => (error ? reject(error) : resolve(opened)),
    );
  });
  try {
    const entries: Entry[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.on("entry", (entry: Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.on("end", resolve);
      zip.on("error", reject);
      zip.readEntry();
    });
    const names = validateArchiveEntries(
      entries.map((entry) => ({
        fileName: entry.fileName,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        compressionMethod: entry.compressionMethod,
        encrypted: entry.isEncrypted(),
      })),
      defaultArchiveLimits,
    );
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i],
        name = names[i],
        target = join(destination, name);
      if (entry.fileName.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          pipeline(stream, createWriteStream(target)).then(resolve).catch(reject);
        });
      });
    }
    return names;
  } finally {
    zip.close();
  }
}

export async function cleanupExtractedJob(path: string) {
  await rm(path, { recursive: true, force: true });
}
