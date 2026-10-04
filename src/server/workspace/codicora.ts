import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { type Element, type Node } from "@xmldom/xmldom";
import { buildEpub } from "../epub/build.js";
import { parseXml } from "../epub/xml-dom.js";
import { DomainError } from "../domain/errors.js";

/**
 * Workspace mode (Codicora WORKSPACE.md, Imprimeor PRD §7.1): a book's `edited/` or
 * `manuscript/` goes in, `localization/<lang>/` in the same MANUSCRIPT.md format comes out. The
 * pipeline is not touched: chapters are wrapped as a synthetic EPUB whose scenes are
 * `<section data-scene>` elements — attributes are never segments, so scene ids survive
 * translation, editing and repair untouched — and the translated staging is read back.
 */
export type WorkspaceText = "edited" | "manuscript";
export type WorkspaceChapter = { slug: string; title: string; text: string };
export type WorkspaceBook = {
  root: string;
  text: WorkspaceText;
  title: string;
  language: string;
  chapters: WorkspaceChapter[];
  /** SHA-256 over the chapters read, so a reader can tell a translation is older than its original. */
  sourceHash: string;
  localizationDir: string;
};
export type WorkspaceLink = { path: string; text: WorkspaceText; sourceHash: string };

type Manifest = {
  language?: unknown;
  chapters?: { slug?: unknown; title?: unknown; file?: unknown }[];
};

const yamlFile = async (path: string) => parseYaml(await readFile(path, "utf8")) as unknown;
const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

/** `edited/` when it exists (WORKSPACE.md: consumers of the finished text prefer it), else `manuscript/`. */
export async function readWorkspace(
  path: string,
  choice: WorkspaceText | "auto" = "auto",
): Promise<WorkspaceBook> {
  const root = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  let config: {
    project?: { title?: string; id?: string };
    manuscript?: { path?: string };
    edited?: { path?: string };
    localization?: { path?: string };
  };
  try {
    config = ((await yamlFile(join(root, "codicora.yaml"))) ?? {}) as typeof config;
  } catch {
    throw new DomainError("workspace_invalid", "No readable codicora.yaml in that folder", 400);
  }
  const dirs: Record<WorkspaceText, string> = {
    edited: resolve(root, config.edited?.path ?? "./edited"),
    manuscript: resolve(root, config.manuscript?.path ?? "./manuscript"),
  };
  const text: WorkspaceText =
    choice !== "auto"
      ? choice
      : (await exists(join(dirs.edited, "manuscript.yaml")))
        ? "edited"
        : "manuscript";
  let manifest: Manifest;
  try {
    manifest = ((await yamlFile(join(dirs[text], "manuscript.yaml"))) ?? {}) as Manifest;
  } catch {
    throw new DomainError(
      "workspace_invalid",
      `${text}/manuscript.yaml is missing or unreadable`,
      400,
    );
  }
  if (!Array.isArray(manifest.chapters) || !manifest.chapters.length)
    throw new DomainError("workspace_invalid", `${text}/manuscript.yaml lists no chapters`, 400);
  const chapters: WorkspaceChapter[] = [];
  for (const c of manifest.chapters) {
    if (typeof c.slug !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(c.slug))
      throw new DomainError("workspace_invalid", `${text}: a chapter has no valid slug`, 400);
    const file = typeof c.file === "string" ? c.file : `chapters/${c.slug}.md`;
    chapters.push({
      slug: c.slug,
      title: typeof c.title === "string" ? c.title : c.slug,
      text: (await readFile(resolve(dirs[text], file), "utf8")).replace(/\r\n?/g, "\n"),
    });
  }
  const hash = createHash("sha256");
  for (const c of chapters) hash.update(`${c.slug}\n${c.title}\n${c.text}\n`);
  return {
    root,
    text,
    title: config.project?.title ?? config.project?.id ?? "Untitled book",
    language: typeof manifest.language === "string" ? manifest.language : "",
    chapters,
    sourceHash: `sha256:${hash.digest("hex")}`,
    localizationDir: resolve(root, config.localization?.path ?? "./localization"),
  };
}

// ---------- Markdown → XHTML ----------

const MARKER = /^<!--\s*scene:\s*(\S+?)\s*-->\s*$/;
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s: string) =>
  escape(s)
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br/>");

function block(paragraph: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(paragraph);
  if (heading) return `<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`;
  return `<p>${inline(paragraph)}</p>`;
}

/** A chapter as XHTML: the title as `<h1>`, one `<section data-scene>` per scene, one block per paragraph. */
export function chapterXhtml(chapter: WorkspaceChapter, language: string): string {
  const scenes: { id: string; lines: string[] }[] = [];
  for (const line of chapter.text.split("\n")) {
    const m = MARKER.exec(line);
    if (m) scenes.push({ id: m[1]!, lines: [] });
    else if (scenes.length || line.trim()) {
      if (!scenes.length) scenes.push({ id: "s0", lines: [] }); // MANUSCRIPT.md §3: text before the first marker
      scenes.at(-1)!.lines.push(line);
    }
  }
  const body = scenes
    .map((s) => {
      const blocks = s.lines
        .join("\n")
        .trim()
        .split(/\n{2,}/)
        .filter(Boolean)
        .map(block);
      return `<section data-scene="${escape(s.id)}">\n${blocks.join("\n")}\n</section>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escape(language)}" xml:lang="${escape(language)}">
<head><title>${escape(chapter.title)}</title></head>
<body data-chapter="${escape(chapter.slug)}">
<h1>${escape(chapter.title)}</h1>
${body}
</body>
</html>
`;
}

/** Writes the synthetic EPUB the ordinary pipeline translates. Chapter files are `text/<slug>.xhtml`. */
export async function buildWorkspaceEpub(book: WorkspaceBook, outputPath: string): Promise<void> {
  const staging = `${outputPath}.${randomUUID()}.d`;
  try {
    const put = async (rel: string, content: string) => {
      await mkdir(join(staging, rel, ".."), { recursive: true });
      await writeFile(join(staging, rel), content);
    };
    const lang = escape(book.language || "und");
    await put("mimetype", "application/epub+zip");
    await put(
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`,
    );
    for (const c of book.chapters)
      await put(`OEBPS/text/${c.slug}.xhtml`, chapterXhtml(c, book.language));
    await put(
      "OEBPS/nav.xhtml",
      `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}"><head><title>${escape(book.title)}</title></head><body><nav epub:type="toc"><ol>${book.chapters.map((c) => `<li><a href="text/${c.slug}.xhtml">${escape(c.title)}</a></li>`).join("")}</ol></nav></body></html>\n`,
    );
    await put(
      "OEBPS/content.opf",
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:sha256:${book.sourceHash.slice(7)}</dc:identifier><dc:title>${escape(book.title)}</dc:title><dc:language>${lang}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${book.chapters.map((c, i) => `<item id="c${i + 1}" href="text/${c.slug}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest>
<spine>${book.chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("")}</spine>
</package>
`,
    );
    await buildEpub(staging, outputPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ---------- translated XHTML → Markdown ----------

function inlineMarkdown(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += child.nodeValue ?? "";
    else if (child.nodeType === 1) {
      const name = (child as Element).localName;
      if (name === "br") out += "\n";
      else if (name === "em" || name === "i") out += `*${inlineMarkdown(child)}*`;
      else if (name === "strong" || name === "b") out += `**${inlineMarkdown(child)}**`;
      else out += inlineMarkdown(child);
    }
  }
  return out;
}

/** The inverse of `chapterXhtml`: title from the first `<h1>`, scenes from their sections. */
export function chapterMarkdown(xhtml: string): { title: string; text: string } {
  const doc = parseXml(xhtml);
  const body = doc.getElementsByTagName("body")[0];
  if (!body) throw new Error("chapter has no body");
  let title = "";
  const scenes: string[] = [];
  for (const el of Array.from(body.childNodes).filter((n): n is Element => n.nodeType === 1)) {
    if (el.localName === "h1" && !title) title = inlineMarkdown(el).trim();
    else if (el.localName === "section") {
      const blocks = Array.from(el.childNodes)
        .filter((n): n is Element => n.nodeType === 1)
        .map((b) => {
          const level = /^h([1-6])$/.exec(b.localName ?? "");
          return `${level ? `${"#".repeat(Number(level[1]))} ` : ""}${inlineMarkdown(b).trim()}`;
        });
      scenes.push(`<!-- scene: ${el.getAttribute("data-scene")} -->\n${blocks.join("\n\n")}\n`);
    }
  }
  return { title, text: scenes.join("\n") };
}

/**
 * Writes `<workspace>/localization/<lang>/` from the job's translated staging. The folder is
 * Trucheman's own (WORKSPACE.md ownership), rewritten whole on every export; `translated_from`
 * records which text and which revision it came from.
 */
export async function exportLocalization(
  stagingRoot: string,
  link: WorkspaceLink,
  targetLanguage: string,
): Promise<{ dir: string; chapters: number }> {
  const book = await readWorkspace(link.path, link.text).catch(() => null);
  const localization = book?.localizationDir ?? resolve(link.path, "localization");
  const slugs =
    (await readFile(join(stagingRoot, "OEBPS", "content.opf"), "utf8"))
      .match(/href="text\/([^"]+)\.xhtml"/g)
      ?.map((h) => h.slice(11, -7)) ?? [];
  if (!slugs.length)
    throw new DomainError("workspace_export", "The translated book has no workspace chapters", 409);
  const dir = join(localization, targetLanguage);
  const next = `${dir}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(next, "chapters"), { recursive: true });
    const chapters: { slug: string; title: string }[] = [];
    for (const slug of slugs) {
      const { title, text } = chapterMarkdown(
        await readFile(join(stagingRoot, "OEBPS", "text", `${slug}.xhtml`), "utf8"),
      );
      await writeFile(join(next, "chapters", `${slug}.md`), text);
      chapters.push({ slug, title: title || slug });
    }
    await writeFile(
      join(next, "manuscript.yaml"),
      `schema_version: 1\nlanguage: ${targetLanguage}\ngenerated_by: trucheman\ntranslated_from:\n  text: ${link.text}\n  hash: "${link.sourceHash}"\n  current: ${book ? book.sourceHash === link.sourceHash : "unknown"}\n  at: ${new Date().toISOString()}\nchapters:\n${chapters.map((c) => `  - slug: ${c.slug}\n    title: ${JSON.stringify(c.title)}\n`).join("")}`,
    );
    // Swap the whole folder: a reader never sees half a translation.
    await rm(`${dir}.old`, { recursive: true, force: true });
    await rename(dir, `${dir}.old`).catch(() => undefined);
    await mkdir(localization, { recursive: true });
    await rename(next, dir);
    await rm(`${dir}.old`, { recursive: true, force: true });
    return { dir, chapters: chapters.length };
  } finally {
    await rm(next, { recursive: true, force: true });
  }
}
