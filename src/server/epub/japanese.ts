import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** A stylesheet the page offers for the other writing direction, by class or by EBPAJ title. */
function directionOf(link: Element): "vertical" | "horizontal" | undefined {
  const marker = `${link.getAttribute("class") ?? ""} ${link.getAttribute("title") ?? ""}`;
  if (/\bvertical\b|縦組/.test(marker)) return "vertical";
  if (/\bhorizontal\b|横組/.test(marker)) return "horizontal";
  return undefined;
}

/**
 * Vertical right-to-left is the layout of the original, not of the translation: the same
 * markup rendering Russian would run the lines down the page and page backwards.
 *
 * The `vrtl` class is only half of the switch. These books also ship *two* stylesheets, one
 * per direction, and choose between them with `rel`: the vertical one is the preferred sheet
 * and the horizontal one is `alternate stylesheet`, which a reader does not apply. Rewriting
 * the class alone changed nothing a reader could see — four finished volumes were delivered
 * still running their lines down the page — because the sheet that sets `writing-mode:
 * vertical-rl` was the one being loaded.
 */
export function horizontalizeContent(doc: Document): number {
  let changed = 0;
  walkElements(doc.documentElement!, (element) => {
    const value = element.getAttribute("class");
    if (value && /\b(vrtl|vltr)\b/.test(value)) {
      element.setAttribute("class", value.replace(/\b(vrtl|vltr)\b/g, "hltr"));
      changed++;
    }
    if (localName(element).toLowerCase() !== "link") return;
    const rel = element.getAttribute("rel") ?? "";
    if (!/stylesheet/i.test(rel)) return;
    const direction = directionOf(element);
    if (!direction) return;
    const alternate = /\balternate\b/i.test(rel);
    // Swap which of the pair the reader loads, and leave any other stylesheet alone.
    if (direction === "vertical" && !alternate) {
      element.setAttribute("rel", "alternate stylesheet");
      changed++;
    } else if (direction === "horizontal" && alternate) {
      element.setAttribute("rel", "stylesheet");
      changed++;
    }
  });
  return changed;
}

/**
 * A font family that only makes sense for Japanese text. Cyrillic exists in Japanese Mincho
 * and Gothic faces, but it is drawn full-width — every letter occupying a CJK em box — so a
 * translated book set in them reads with enormous gaps between the letters. None of these
 * books embeds a font: the families are names of system fonts, and the aliases they define
 * (`serif-ja`) resolve to `local("ＭＳ 明朝")`, so dropping them simply lets the reader use its
 * own serif, which draws Cyrillic at the width it was designed for.
 */
const JAPANESE_FAMILY =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|^@|hiragino|mincho|gothic|meiryo|ipa|yu[\s-]?(mincho|gothic)|-ja(-v)?$|^ms[\s-]/iu;

const GENERIC_FAMILY = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i;

/** Rewrite one `font-family` value, keeping whatever is not Japanese-only. */
export function latinizeFontStack(value: string): string {
  const families = value
    .split(",")
    .map((family) => family.trim())
    .filter(Boolean);
  const kept = families.filter(
    (family) => !JAPANESE_FAMILY.test(family.replace(/^["']|["']$/g, "")),
  );
  if (kept.some((family) => GENERIC_FAMILY.test(family))) return kept.join(", ");
  // Everything named was Japanese: fall back to the generic the stack was reaching for.
  const generic = /gothic|kaku|sans/i.test(value) ? "sans-serif" : "serif";
  return [...kept, generic].join(", ");
}

/** Every `font-family` in a stylesheet, `!important` and all. */
export function latinizeStylesheet(css: string): { value: string; changes: number } {
  let changes = 0;
  const value = css.replace(/font-family\s*:\s*([^;{}]+)/gi, (whole, list: string) => {
    const important = /!\s*important\s*$/i.exec(list)?.[0] ?? "";
    const next = latinizeFontStack(list.slice(0, list.length - important.length));
    const replacement = `font-family: ${next}${important ? ` ${important.trim()}` : ""}`;
    if (replacement !== whole.trim()) changes++;
    return replacement;
  });
  return { value, changes };
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

/**
 * The stylesheets of a staged book, rewritten so its Cyrillic is not set in a Japanese face.
 * Kept apart from the content passes because a stylesheet is shared: one file serves every
 * document, so it is rewritten once rather than per document.
 */
export async function latinizeStagedStylesheets(staging: string): Promise<number> {
  let changes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".css")) continue;
      const original = await readFile(path, "utf8");
      const rewritten = latinizeStylesheet(original);
      if (!rewritten.changes) continue;
      await writeFile(path, rewritten.value);
      changes += rewritten.changes;
    }
  };
  await walk(staging);
  return changes;
}

/** Both content-document passes, for the one call site that runs over every document. */
export function normalizeJapaneseContent(doc: Document, readings: Map<string, string>): boolean {
  const flattened = flattenRuby(doc, readings);
  const horizontalized = horizontalizeContent(doc);
  return flattened + horizontalized > 0;
}
