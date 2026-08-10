import { createHash } from "node:crypto";
import { type Document, type Node } from "@xmldom/xmldom";
import { localName } from "./xml-dom.js";
export type TextSegment = {
  id: string;
  text: string;
  sourceHash: string;
  locator: number[];
  leading: string;
  trailing: string;
  /** Index of the nearest enclosing logical block; text nodes sharing it are one sentence. */
  block?: number;
  /**
   * The chain of semantic inline elements wrapping this node inside its block ("" when
   * none, "a" inside a link, "a>em" inside emphasis inside a link). Two nodes may merge
   * only when this matches: that keeps `<em>` in mid-paragraph a boundary while letting a
   * table-of-contents entry typeset as `<a><span>Part</span> <span>5</span></a>` rejoin.
   */
  format?: string;
};
const excluded = new Set(["script", "style", "pre", "code", "math", "svg"]);
/**
 * Elements that start a new logical text block. Fragmented EPUBs split one heading or
 * sentence across sibling `<span>`s; translating those independently produced garbage
 * like "В пустыне пустыня", so the block — not the text node — is the translation unit.
 */
const blockElements = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "div",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "li",
  "main",
  "nav",
  "p",
  "section",
  "td",
  "text", // NCX navLabel/text
  "th",
  "title",
]);
/** Inline elements whose boundaries carry meaning and must keep their own text node. */
const semanticInline = new Set([
  "a",
  "abbr",
  "b",
  "cite",
  "code",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function splitWhitespace(text: string) {
  const leading = text.match(/^\s*/)?.[0] ?? "",
    trailing = text.match(/\s*$/)?.[0] ?? "";
  return {
    leading,
    trailing,
    body: text.slice(leading.length, Math.max(leading.length, text.length - trailing.length)),
  };
}
export function extractTextSegments(doc: Document, documentId: string): TextSegment[] {
  const out: TextSegment[] = [];
  let block = 0;
  const walk = (node: Node, locator: number[], blocked = false, format = "") => {
    if (node.nodeType === 1) {
      const element = node as any;
      const name = localName(node).toLowerCase();
      blocked ||= excluded.has(name) || element.getAttribute?.("translate") === "no";
      // A line break ends the logical block just as a block element does.
      if (name === "br") {
        block++;
        return;
      }
      const isBlock = blockElements.has(name);
      if (isBlock) block++;
      const childFormat = isBlock
        ? ""
        : semanticInline.has(name)
          ? `${format}${format ? ">" : ""}${name}`
          : format;
      let i = 0;
      for (let c = node.firstChild; c; c = c.nextSibling, i++)
        walk(c, [...locator, i], blocked, childFormat);
      // Text following a nested block belongs to a new logical block, not the one inside.
      if (isBlock) block++;
      return;
    }
    if (node.nodeType !== 3 || blocked) return;
    const raw = node.nodeValue ?? "",
      parts = splitWhitespace(raw);
    if (!parts.body.trim()) return;
    const id = `${documentId}:${out.length.toString(36)}`;
    out.push({
      id,
      text: raw,
      sourceHash: hash(raw),
      locator,
      leading: parts.leading,
      trailing: parts.trailing,
      block,
      format,
    });
  };
  if (doc.documentElement) walk(doc.documentElement, []);
  return out;
}

export type LogicalBlocks = {
  /** The translation units: one per logical block, in document order. */
  units: TextSegment[];
  /** Absorbed segment id → the unit id that now carries its text. */
  absorbed: Map<string, string>;
};

function joinBlockText(parts: string[]): string {
  return parts.reduce((joined, part) => {
    if (!joined) return part;
    return /\s$/u.test(joined) || /^\s/u.test(part) ? joined + part : `${joined} ${part}`;
  }, "");
}

/**
 * Merge consecutive text nodes that share a logical block and an inline formatting
 * context into one translation unit. Emphasis in mid-paragraph still splits the block,
 * because its boundary carries meaning; the fragmented `<span>` typesetting that produced
 * one-word segments collapses back into the sentence the author wrote, including inside a
 * table-of-contents `<a>` that wraps the whole entry.
 */
export function mergeLogicalBlocks(segments: TextSegment[]): LogicalBlocks {
  const units: TextSegment[] = [];
  const absorbed = new Map<string, string>();
  let index = 0;
  while (index < segments.length) {
    const first = segments[index];
    let end = index + 1;
    if (first.block !== undefined) {
      while (
        end < segments.length &&
        segments[end].block === first.block &&
        segments[end].format === first.format
      ) {
        end++;
      }
    }
    if (end - index < 2) {
      units.push(first);
      index = end;
      continue;
    }
    const members = segments.slice(index, end);
    units.push({
      ...first,
      text: joinBlockText(members.map((member) => member.text)),
      trailing: members[members.length - 1].trailing,
    });
    for (const member of members.slice(1)) absorbed.set(member.id, first.id);
    index = end;
  }
  return { units, absorbed };
}
export function reinsertText(
  doc: Document,
  segments: TextSegment[],
  values: Map<string, string>,
): void {
  for (const s of segments) {
    let n: Node | null = doc.documentElement;
    for (const i of s.locator) {
      n = n?.childNodes.item(i) ?? null;
      if (!n) throw new Error(`Locator not found: ${s.id}`);
    }
    if (!n || n.nodeType !== 3 || hash(n.nodeValue ?? "") !== s.sourceHash)
      throw new Error(`Source changed: ${s.id}`);
    const value = values.get(s.id);
    if (value !== undefined) (n as any).data = s.leading + value.trim() + s.trailing;
  }
}
