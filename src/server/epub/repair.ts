import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import type { Document, Element, Node } from "@xmldom/xmldom";
import { localName, parseXml, serializeXml } from "./xml-dom.js";

export type EpubRepairSummary = {
  renamedEntries: number;
  updatedReferences: number;
  rewrittenIds: number;
  removedLegacyAttributes: number;
  convertedAnchors: number;
  restructuredParagraphs: number;
  /** Manifest items whose document runs a script and never said so. */
  declaredScripted: number;
  /** `dtb:uid` rewritten to the identifier the package actually publishes. */
  alignedNcxIdentifier: number;
  /** `refines` metadata pointing at an id no longer in the package. */
  droppedDanglingRefines: number;
};

type EntryMapping = { oldPath: string; newPath: string };
const XML_EXTENSIONS = new Set([".xml", ".opf", ".ncx", ".xhtml", ".html", ".htm", ".svg"]);
const TEXT_EXTENSIONS = new Set([...XML_EXTENSIONS, ".css"]);
const RESOURCE_ATTRIBUTES = new Set(["data", "full-path", "href", "poster", "src", "xlink:href"]);
const PARAGRAPH_BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

function extension(path: string) {
  const match = /\.[^.\/]+$/.exec(path);
  return match?.[0].toLowerCase() ?? "";
}

async function files(root: string, dir = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await files(root, path)));
    else output.push(relative(root, path).split("\\").join("/"));
  }
  return output;
}

function repairedPath(path: string) {
  return path
    .split("/")
    .map((part) => part.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_"))
    .join("/");
}

function encodedPath(path: string) {
  return path
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function replaceAll(value: string, search: string, replacement: string) {
  return search ? value.split(search).join(replacement) : value;
}

function updateResourceReferences(
  input: string,
  document: EntryMapping,
  mappings: EntryMapping[],
): { value: string; changes: number } {
  let value = input;
  let changes = 0;
  for (const target of mappings) {
    const oldReference = posix.relative(posix.dirname(document.oldPath), target.oldPath);
    const newReference = posix.relative(posix.dirname(document.newPath), target.newPath);
    const encodedOld = encodedPath(oldReference);
    const encodedNew = encodedPath(newReference);
    for (const [from, to] of [
      [oldReference, newReference],
      [encodedOld, encodedNew],
      [encodedOld.replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase()), encodedNew],
    ]) {
      if (from === to || !value.includes(from)) continue;
      const occurrences = value.split(from).length - 1;
      value = replaceAll(value, from, to);
      changes += occurrences;
    }
  }
  return { value, changes };
}

function updateStylesheetReferences(
  input: string,
  document: EntryMapping,
  mappings: EntryMapping[],
): { value: string; changes: number } {
  let changes = 0;
  const update = (reference: string) => {
    const result = updateResourceReferences(reference, document, mappings);
    changes += result.changes;
    return result.value;
  };
  let value = input.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (_match, quote: string, reference: string) => `url(${quote}${update(reference)}${quote})`,
  );
  value = value.replace(
    /(@import\s+)(["'])([^"']+)\2/gi,
    (_match, prefix: string, quote: string, reference: string) =>
      `${prefix}${quote}${update(reference)}${quote}`,
  );
  return { value, changes };
}

function elements(node: Node): Element[] {
  const output: Element[] = [];
  if (node.nodeType === 1) output.push(node as Element);
  for (let child = node.firstChild; child; child = child.nextSibling)
    output.push(...elements(child));
  return output;
}

function appendStyle(element: Element, declaration: string) {
  const current = element.getAttribute("style")?.trim();
  element.setAttribute(
    "style",
    current ? `${current.replace(/;?$/, ";")} ${declaration}` : declaration,
  );
}

function validXmlId(value: string) {
  return /^[A-Za-z_][A-Za-z0-9._-]*$/.test(value);
}

function hasParagraphContent(element: Element) {
  return elements(element).length > 1 || Boolean((element.textContent ?? "").trim());
}

/**
 * XHTML follows HTML's content model: a paragraph cannot own headings, lists, tables, or
 * another block. PDF-derived EPUBs commonly wrap an outline in one giant `<p>`, which XML
 * parsers accept but EPUBCheck rejects. Split such wrappers while preserving any inline text
 * before, between, and after their block children.
 */
export function repairInvalidParagraphNesting(doc: Document): number {
  const paragraphs = elements(doc.documentElement!).filter(
    (element) =>
      localName(element).toLowerCase() === "p" &&
      [
        ...Array.from({ length: element.childNodes.length }, (_, index) =>
          element.childNodes.item(index),
        ),
      ]
        .filter((child): child is Node => child !== null && child.nodeType === 1)
        .some((child) => PARAGRAPH_BLOCK_ELEMENTS.has(localName(child).toLowerCase())),
  );
  let repaired = 0;
  for (const paragraph of paragraphs) {
    const parent = paragraph.parentNode;
    if (!parent) continue;
    let inline = paragraph.cloneNode(false) as Element;
    while (paragraph.firstChild) {
      const child = paragraph.firstChild;
      paragraph.removeChild(child);
      if (child.nodeType === 1 && PARAGRAPH_BLOCK_ELEMENTS.has(localName(child).toLowerCase())) {
        if (hasParagraphContent(inline)) parent.insertBefore(inline, paragraph);
        parent.insertBefore(child, paragraph);
        inline = paragraph.cloneNode(false) as Element;
      } else {
        inline.appendChild(child);
      }
    }
    if (hasParagraphContent(inline)) parent.insertBefore(inline, paragraph);
    parent.removeChild(paragraph);
    repaired++;
  }
  return repaired;
}

function uniqueId(value: string, used: Set<string>) {
  let base = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[A-Za-z_]/.test(base)) base = `id-${base}`;
  if (!base) base = "id-repaired";
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
  used.add(candidate);
  return candidate;
}

function repairXml(doc: Document, summary: EpubRepairSummary) {
  const root = doc.documentElement;
  if (!root) return;
  const all = elements(root);
  const used = new Set<string>();
  for (const element of all) {
    const id = element.getAttribute("id");
    if (id && validXmlId(id)) used.add(id);
  }

  const rewritten = new Map<string, string>();
  const isXhtml = localName(root).toLowerCase() === "html";
  if (isXhtml) summary.restructuredParagraphs += repairInvalidParagraphNesting(doc);
  const isEpub2Package =
    localName(root).toLowerCase() === "package" &&
    !(root.getAttribute("version")?.startsWith("3") ?? false);
  if (isEpub2Package && root.hasAttribute("xml:lang")) {
    root.removeAttribute("xml:lang");
    summary.removedLegacyAttributes++;
  }
  for (const element of all) {
    const id = element.getAttribute("id");
    if (id && !validXmlId(id)) {
      const replacement = uniqueId(id, used);
      element.setAttribute("id", replacement);
      rewritten.set(id, replacement);
      summary.rewrittenIds++;
    }
    if (!isXhtml) continue;
    if (localName(element).toLowerCase() === "a" && element.hasAttribute("name")) {
      const name = element.getAttribute("name")!;
      const target = element.getAttribute("id") || uniqueId(name, used);
      if (!element.hasAttribute("id")) element.setAttribute("id", target);
      if (name !== target) rewritten.set(name, target);
      element.removeAttribute("name");
      summary.removedLegacyAttributes++;
    }
    for (let index = element.attributes.length - 1; index >= 0; index--) {
      const attribute = element.attributes.item(index)!;
      const name = attribute.name.toLowerCase();
      if (name === "clear") {
        appendStyle(element, `clear: ${attribute.value}`);
        element.removeAttributeNode(attribute);
        summary.removedLegacyAttributes++;
      } else if (name === "border") {
        appendStyle(
          element,
          `border-width: ${/^\d+$/.test(attribute.value) ? `${attribute.value}px` : attribute.value}`,
        );
        element.removeAttributeNode(attribute);
        summary.removedLegacyAttributes++;
      } else if (name.startsWith("v:")) {
        element.removeAttributeNode(attribute);
        summary.removedLegacyAttributes++;
      }
    }
    if (
      localName(element).toLowerCase() === "a" &&
      localName(element.parentNode!).toLowerCase() === "body" &&
      !element.hasAttribute("href") &&
      !(element.textContent ?? "").trim()
    ) {
      const replacement = doc.createElementNS(element.namespaceURI, "div");
      for (let index = 0; index < element.attributes.length; index++) {
        const attribute = element.attributes.item(index)!;
        replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      }
      while (element.firstChild) replacement.appendChild(element.firstChild);
      element.parentNode!.replaceChild(replacement, element);
      summary.convertedAnchors++;
    }
  }

  if (localName(root).toLowerCase() === "package") {
    // Kobo and calibre rename the element an EBPAJ package refines and leave the pointer
    // behind: `refines="#creator01"` against a `<dc:creator id="id-1">`. What it refines no
    // longer exists, so the metadata describes nothing and EPUBCheck rejects the book over it.
    // Repointing is not available — the surviving id usually carries the same property already.
    const ids = new Set(
      elements(root).flatMap((element) => {
        const value = element.getAttribute("id");
        return value ? [value] : [];
      }),
    );
    for (const element of elements(root)) {
      const refines = element.getAttribute("refines");
      if (!refines?.startsWith("#") || ids.has(refines.slice(1))) continue;
      element.parentNode?.removeChild(element);
      summary.droppedDanglingRefines++;
    }
  }

  if (!rewritten.size) return;
  for (const element of elements(root)) {
    for (let index = 0; index < element.attributes.length; index++) {
      const attribute = element.attributes.item(index)!;
      let next = attribute.value;
      for (const [oldId, newId] of rewritten) {
        if (next === oldId) next = newId;
        next = replaceAll(next, `#${oldId}`, `#${newId}`);
      }
      if (next !== attribute.value) {
        attribute.value = next;
        summary.updatedReferences++;
      }
    }
  }
}

/**
 * The two conformance errors that cannot be seen from inside a single file.
 *
 * A reader-produced EPUB ships `js/kobo.js` in every page and never declares it, which is one
 * OPF-014 per content document — twenty-five of the thirty errors left on one book. And a
 * package rebuilt by one tool and paginated by another ends up with an NCX announcing a
 * different `dtb:uid` than the identifier the package publishes. Both are mechanical: the
 * manifest is simply describing its own files wrongly, and this pass makes it describe them
 * as they are rather than changing anything a reader sees.
 */
async function repairPackageDeclarations(destination: string, summary: EpubRepairSummary) {
  let packagePath: string;
  try {
    const container = parseXml(await readFile(join(destination, "META-INF/container.xml"), "utf8"));
    const rootfile = elements(container.documentElement!).find(
      (element) => localName(element).toLowerCase() === "rootfile",
    );
    packagePath = rootfile?.getAttribute("full-path") ?? "";
  } catch {
    return;
  }
  if (!packagePath) return;
  const packageFile = join(destination, packagePath);
  let dom: Document;
  try {
    dom = parseXml(await readFile(packageFile, "utf8"));
  } catch {
    return;
  }
  const all = elements(dom.documentElement!);
  const items = all.filter((element) => localName(element).toLowerCase() === "item");
  const base = posix.dirname(packagePath);

  for (const item of items) {
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") ?? "";
    if (!href || href.includes("://") || !/(xhtml|html)/i.test(mediaType)) continue;
    const properties = (item.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean);
    if (properties.includes("scripted")) continue;
    let markup: string;
    try {
      markup = await readFile(
        join(destination, posix.join(base, decodeURIComponent(href))),
        "utf8",
      );
    } catch {
      continue;
    }
    if (!/<script[\s>]/i.test(markup)) continue;
    item.setAttribute("properties", [...properties, "scripted"].join(" "));
    summary.declaredScripted++;
  }

  const uniqueId = dom.documentElement!.getAttribute("unique-identifier");
  const identifier = all
    .find(
      (element) =>
        localName(element).toLowerCase() === "identifier" &&
        (!uniqueId || element.getAttribute("id") === uniqueId),
    )
    ?.textContent?.trim();
  const ncxItem = items.find(
    (item) =>
      /x-dtbncx/i.test(item.getAttribute("media-type") ?? "") ||
      item.getAttribute("href")?.toLowerCase().endsWith(".ncx"),
  );
  const ncxHref = ncxItem?.getAttribute("href");
  if (identifier && ncxHref) {
    const ncxPath = join(destination, posix.join(base, decodeURIComponent(ncxHref)));
    try {
      const ncx = parseXml(await readFile(ncxPath, "utf8"));
      const uid = elements(ncx.documentElement!).find(
        (element) =>
          localName(element).toLowerCase() === "meta" &&
          element.getAttribute("name")?.toLowerCase() === "dtb:uid",
      );
      if (uid && uid.getAttribute("content") !== identifier) {
        uid.setAttribute("content", identifier);
        await writeFile(ncxPath, serializeXml(ncx));
        summary.alignedNcxIdentifier++;
      }
    } catch {
      // An unreadable NCX is the archive validator's finding, not this pass's to force.
    }
  }

  if (summary.declaredScripted) await writeFile(packageFile, serializeXml(dom));
}

/** Copy staging into an isolated, repaired workspace without mutating translation checkpoints. */
export async function createRepairedEpubWorkspace(
  source: string,
  destination: string,
): Promise<EpubRepairSummary> {
  const sourceFiles = await files(source);
  const mappings = sourceFiles.map((oldPath) => ({ oldPath, newPath: repairedPath(oldPath) }));
  const destinations = new Set<string>();
  for (const mapping of mappings) {
    if (destinations.has(mapping.newPath))
      throw new Error(`Repair would create a duplicate EPUB entry: ${mapping.newPath}`);
    destinations.add(mapping.newPath);
    await mkdir(dirname(join(destination, mapping.newPath)), { recursive: true });
    await copyFile(join(source, mapping.oldPath), join(destination, mapping.newPath));
  }

  const summary: EpubRepairSummary = {
    renamedEntries: mappings.filter((mapping) => mapping.oldPath !== mapping.newPath).length,
    updatedReferences: 0,
    rewrittenIds: 0,
    removedLegacyAttributes: 0,
    convertedAnchors: 0,
    restructuredParagraphs: 0,
    declaredScripted: 0,
    alignedNcxIdentifier: 0,
    droppedDanglingRefines: 0,
  };
  for (const document of mappings) {
    if (!TEXT_EXTENSIONS.has(extension(document.newPath))) continue;
    const path = join(destination, document.newPath);
    const original = await readFile(path, "utf8");
    let value: string;
    if (XML_EXTENSIONS.has(extension(document.newPath))) {
      const dom = parseXml(original);
      for (const element of elements(dom.documentElement!)) {
        for (let index = 0; index < element.attributes.length; index++) {
          const attribute = element.attributes.item(index)!;
          if (!RESOURCE_ATTRIBUTES.has(attribute.name.toLowerCase())) continue;
          const references = updateResourceReferences(attribute.value, document, mappings);
          if (references.value !== attribute.value) attribute.value = references.value;
          summary.updatedReferences += references.changes;
        }
      }
      repairXml(dom, summary);
      value = serializeXml(dom);
    } else {
      const references = updateStylesheetReferences(original, document, mappings);
      value = references.value;
      summary.updatedReferences += references.changes;
    }
    if (value !== original) await writeFile(path, value);
  }
  await repairPackageDeclarations(destination, summary);
  return summary;
}
