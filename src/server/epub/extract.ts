import yauzl, { type Entry } from "yauzl";
import { mkdir, open, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { defaultArchiveLimits, validateArchiveEntries } from "./archive-policy.js";
import { safeJobPath } from "../storage/job-paths.js";

const zipOptions: yauzl.Options = {
  autoClose: false,
  lazyEntries: true,
  decodeStrings: true,
  strictFileNames: true,
  validateEntrySizes: true,
};

class FileRandomAccessReader extends yauzl.RandomAccessReader {
  constructor(private readonly source: string) {
    super();
  }

  override _readStreamForRange(start: number, end: number) {
    return createReadStream(this.source, { start, end: end - 1 });
  }
}

function openZip(source: string, logicalSize?: number): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, opened: yauzl.ZipFile) =>
      error ? reject(error) : resolve(opened);
    if (logicalSize === undefined) yauzl.open(source, zipOptions, callback);
    else
      yauzl.fromRandomAccessReader(
        new FileRandomAccessReader(source),
        logicalSize,
        zipOptions,
        callback,
      );
  });
}

async function sizeWithoutTrailingNull(source: string): Promise<number | undefined> {
  const handle = await open(source, "r");
  try {
    const { size } = await handle.stat();
    // EOCD is 22 bytes plus at most 65,535 bytes of comment and the trailing NUL.
    const tail = Buffer.alloc(Math.min(size, 65_558));
    const tailStart = size - tail.length;
    await handle.read(tail, 0, tail.length, tailStart);
    const signatureOffset = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (signatureOffset < 0 || signatureOffset + 22 > tail.length) return undefined;
    const commentLength = tail.readUInt16LE(signatureOffset + 20);
    const logicalSize = tailStart + signatureOffset + 22 + commentLength;
    return logicalSize === size - 1 && tail.at(-1) === 0 ? logicalSize : undefined;
  } finally {
    await handle.close();
  }
}

async function openEpubZip(source: string): Promise<yauzl.ZipFile> {
  try {
    return await openZip(source);
  } catch (error) {
    const logicalSize = await sizeWithoutTrailingNull(source);
    if (logicalSize === undefined) throw error;
    return openZip(source, logicalSize);
  }
}

export async function extractEpub(source: string, destination: string): Promise<string[]> {
  await mkdir(destination, { recursive: true });
  const zip = await openEpubZip(source);
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
        target = safeJobPath(destination, name);
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
