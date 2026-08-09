import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { parseContainer, parsePackage } from "./package-parser.js";
import { parseXml } from "./xml-dom.js";
import { extractEpub } from "./extract.js";
import { safeJobPath } from "../storage/job-paths.js";

export type ValidationReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  documents: number;
};

const encodedSeparator = /%(?:2f|5c)/i;
const uriScheme = /^[A-Za-z][A-Za-z\d+.-]*:/;

/** Resolve an EPUB-internal reference while keeping it inside the extracted root. */
export function resolveEpubPath(root: string, reference: string, baseDirectory = ""): string {
  if (
    !reference ||
    reference !== reference.trim() ||
    reference.includes("\\") ||
    reference.includes("\0") ||
    reference.includes("?") ||
    reference.includes("#") ||
    encodedSeparator.test(reference)
  )
    throw new Error(`Unsafe EPUB path: ${reference}`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    throw new Error(`Invalid encoded EPUB path: ${reference}`);
  }
  if (
    !decoded ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    encodedSeparator.test(decoded) ||
    posix.isAbsolute(decoded) ||
    decoded.startsWith("//") ||
    uriScheme.test(decoded) ||
    /^[A-Za-z]:/.test(decoded)
  )
    throw new Error(`Unsafe EPUB path: ${reference}`);
  const relativePath = posix.normalize(posix.join(baseDirectory, decoded));
  if (relativePath === "." || relativePath === ".." || relativePath.startsWith("../"))
    throw new Error(`EPUB path escapes its root: ${reference}`);
  return safeJobPath(root, relativePath);
}

export async function validateEpub(root: string): Promise<ValidationReport> {
  const errors: string[] = [],
    warnings: string[] = [];
  let documents = 0;
  try {
    await access(join(root, "mimetype"));
    if ((await readFile(join(root, "mimetype"), "utf8")) !== "application/epub+zip")
      errors.push("Invalid mimetype");
    const container = await readFile(join(root, "META-INF/container.xml"), "utf8");
    const packagePath = parseContainer(container);
    const packageFile = resolveEpubPath(root, packagePath);
    const pkg = await readFile(packageFile, "utf8"),
      book = parsePackage(pkg, packagePath);
    for (const id of book.spine) {
      const item = book.manifest.get(id);
      if (!item) {
        errors.push(`Missing spine item ${id}`);
        continue;
      }
      try {
        const resource = resolveEpubPath(root, item.href, posix.dirname(packagePath));
        parseXml(await readFile(resource));
        documents++;
      } catch {
        errors.push(`Invalid XML or unsafe path ${item.href}`);
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "Unable to validate EPUB");
  }
  return { ok: errors.length === 0, errors, warnings, documents };
}

/** Validate the bytes that will actually be published, not merely their source tree. */
export async function validateEpubArchive(archivePath: string): Promise<ValidationReport> {
  const extracted = await mkdtemp(join(tmpdir(), "book-translator-validation-"));
  try {
    await extractEpub(archivePath, extracted);
    return await validateEpub(extracted);
  } catch (e) {
    return {
      ok: false,
      errors: [e instanceof Error ? e.message : "Unable to validate EPUB archive"],
      warnings: [],
      documents: 0,
    };
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}
