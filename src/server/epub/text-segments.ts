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
};
const excluded = new Set(["script", "style", "pre", "code", "math", "svg"]);
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
  const walk = (node: Node, locator: number[], blocked = false) => {
    if (node.nodeType === 1) {
      const element = node as any;
      const name = localName(node).toLowerCase();
      blocked ||= excluded.has(name) || element.getAttribute?.("translate") === "no";
      let i = 0;
      for (let c = node.firstChild; c; c = c.nextSibling, i++) walk(c, [...locator, i], blocked);
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
    });
  };
  if (doc.documentElement) walk(doc.documentElement, []);
  return out;
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
