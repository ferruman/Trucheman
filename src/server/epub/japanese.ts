import type { Document, Element, Node } from "@xmldom/xmldom";
import { localName } from "./xml-dom.js";
import { baseLanguageTag } from "../config/target-language.js";

export function isJapanese(tag: string | undefined): boolean {
  return Boolean(tag) && baseLanguageTag(tag!) === "ja";
}

function walkElements(node: Node, visit: (element: Element) => void) {
  if (node.nodeType === 1) visit(node as Element);
  for (let child = node.firstChild; child; child = child.nextSibling) walkElements(child, visit);
}

const HAN = /\p{Script=Han}/u;

/**
 * Furigana is a pronunciation gloss over the base text, not a second reading of it. Left in
 * place it is translated as its own segment — `<ruby>` and `<rt>` are segment boundaries in
 * `text-segments.ts` — so a Japanese book pays for some three thousand kana strings per volume
 * and gets each of them transliterated on top of the word it glosses. Flatten the ruby to its
 * base and keep the reading, which is the one thing that makes a name transliterable:
 * 加藤保憲 alone is a guess, 加藤保憲/かとうやすのり is Като Ясунори.
 */
export function flattenRuby(doc: Document, readings = new Map<string, string>()): number {
  const rubies: Element[] = [];
  walkElements(doc.documentElement!, (element) => {
    if (localName(element).toLowerCase() === "ruby") rubies.push(element);
  });
  // Innermost first: nested ruby would otherwise be detached before it is read.
  for (const ruby of rubies.reverse()) {
    const parent = ruby.parentNode;
    if (!parent) continue;
    const base: Node[] = [];
    let reading = "";
    while (ruby.firstChild) {
      const child = ruby.firstChild;
      ruby.removeChild(child);
      const name = child.nodeType === 1 ? localName(child).toLowerCase() : "";
      if (name === "rt") reading += child.textContent ?? "";
      else if (name !== "rp") base.push(child);
    }
    const written = base
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    if (written && reading.trim() && HAN.test(written)) readings.set(written, reading.trim());
    for (const node of base) parent.insertBefore(node, ruby);
    parent.removeChild(ruby);
  }
  // Lifting the base out leaves the text that surrounded the ruby in separate sibling nodes,
  // and a parser reading the file back merges them. Left split, the same paragraph segments
  // one way in memory and another way on disk, and assembly rejects the document it prepared
  // with "Source changed". Merging here also stops every glossed word from being segmented,
  // paid for, and translated alone, out of the sentence that explains it.
  if (rubies.length) doc.documentElement!.normalize();
  return rubies.length;
}

/**
 * Vertical right-to-left is the layout of the original, not of the translation: the same
 * markup rendering Russian would run the lines down the page and page backwards. The class is
 * the whole switch — EBPAJ stylesheets, which is what these books ship, define `.hltr` next to
 * `.vrtl` — and a book whose stylesheet lacks the rule falls back to horizontal anyway.
 */
export function horizontalizeContent(doc: Document): number {
  let changed = 0;
  walkElements(doc.documentElement!, (element) => {
    const value = element.getAttribute("class");
    if (!value || !/\b(vrtl|vltr)\b/.test(value)) return;
    element.setAttribute("class", value.replace(/\b(vrtl|vltr)\b/g, "hltr"));
    changed++;
  });
  return changed;
}

/** The reading order of the spine itself: `rtl` pages a translated book backwards. */
export function horizontalizePackage(doc: Document): boolean {
  let changed = false;
  walkElements(doc.documentElement!, (element) => {
    if (localName(element).toLowerCase() !== "spine") return;
    if (element.getAttribute("page-progression-direction") === "rtl") {
      element.setAttribute("page-progression-direction", "ltr");
      changed = true;
    }
  });
  return changed;
}

/** Both content-document passes, for the one call site that runs over every document. */
export function normalizeJapaneseContent(doc: Document, readings: Map<string, string>): boolean {
  const flattened = flattenRuby(doc, readings);
  const horizontalized = horizontalizeContent(doc);
  return flattened + horizontalized > 0;
}
