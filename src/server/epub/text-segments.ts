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
/**
 * Semantic inline elements whose boundary is decorative rather than structural. A block
 * merges across these, giving up the markup on the absorbed side: a sentence chopped at an
 * `<i>` translates far worse than it reads without the italics. Translating `<i>Emma</i>`
 * and the bare `The ` around it as separate units produced «Эмма», «Эмма» and an invented
 * `Люди с «` in the Cthulhu run. Links, footnote markers and ruby annotations stay
 * boundaries — there the element's own text is the point.
 */
const presentationalInline = new Set([
  "b",
  "cite",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "mark",
  "s",
  "samp",
  "small",
  "strong",
  "u",
  "var",
]);

/**
 * True when `format` is `base` wrapped in nothing but decorative inline elements, so the
 * node's text may move outward into a `base` node. Deliberately one-directional: text is
 * never pulled *into* a wrapper, which would italicise the whole sentence around it.
 */
export function mergesInto(format = "", base = ""): boolean {
  if (format === base) return true;
  if (base && !format.startsWith(`${base}>`)) return false;
  const extra = base ? format.slice(base.length + 1) : format;
  return extra.split(">").every((name) => presentationalInline.has(name));
}

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

/**
 * A fragment begins a new word — as opposed to continuing the previous one. Trailing
 * punctuation and possessives hug what precedes them, so joining `<i>Emma</i>` with the
 * `, he says` after it must not manufacture "Emma , he says". Straight quotes stay out:
 * "'s" is a possessive far more often than "'" opens a quotation.
 */
const startsNewWord = /^[\p{L}\p{N}(\[{«“„¿¡#$£€]/u;

function joinBlockText(parts: string[]): string {
  return parts.reduce((joined, part) => {
    if (!joined) return part;
    const spaced = /\s$/u.test(joined) || /^\s/u.test(part) || !startsNewWord.test(part);
    return spaced ? joined + part : `${joined} ${part}`;
  }, "");
}

/**
 * Merge consecutive text nodes that share a logical block and a compatible inline
 * formatting context into one translation unit. The fragmented `<span>` typesetting that
 * produced one-word segments collapses back into the sentence the author wrote, including
 * inside a table-of-contents `<a>` that wraps the whole entry, and — see `mergesInto` —
 * across decorative emphasis, whose markup is given up to keep the sentence whole.
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
        mergesInto(segments[end].format, first.format)
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
