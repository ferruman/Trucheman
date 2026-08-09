import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";
export function parseXml(input: string | Buffer): Document {
  let error: string | undefined;
  const doc = new DOMParser({
    errorHandler: (level, msg) => {
      if (level !== "warning") error = msg;
    },
  }).parseFromString(input.toString("utf8"), "application/xml");
  if (error || !doc.documentElement) throw new Error(`Malformed XML${error ? `: ${error}` : ""}`);
  return doc;
}
export function serializeXml(doc: Document): string {
  const out = new XMLSerializer().serializeToString(doc);
  parseXml(out);
  return out;
}
export function localName(node: Node): string {
  return (node as Element).localName || (node.nodeName ?? "").split(":").pop()!;
}
export function elementChildren(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
}
export function structuralSnapshot(node: Node): unknown {
  const attrs: string[] = [];
  if ((node as Element).attributes)
    for (let i = 0; i < (node as Element).attributes.length; i++) {
      const a = (node as Element).attributes.item(i)!;
      attrs.push(`${a.namespaceURI ?? ""}|${a.localName ?? a.name}=${a.value}`);
    }
  const children = [];
  for (let c = node.firstChild; c; c = c.nextSibling)
    children.push(c.nodeType === 1 ? structuralSnapshot(c) : [c.nodeType, c.nodeValue]);
  return [
    node.nodeType,
    (node as Element).namespaceURI ?? "",
    localName(node),
    attrs.sort(),
    children,
  ];
}
