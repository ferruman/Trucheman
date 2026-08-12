import type { Document, Element, Node } from "@xmldom/xmldom";
import { localName } from "./xml-dom.js";

const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const FILE_GENERATOR = "Book Translator";

function walkElements(node: Node, visit: (element: Element) => void) {
  if (node.nodeType === 1) visit(node as Element);
  for (let child = node.firstChild; child; child = child.nextSibling) {
    walkElements(child, visit);
  }
}

/**
 * Preserve the publication's bibliographic record while refreshing metadata that describes the
 * translated EPUB file itself.
 */
export function updatePackageLanguage(
  doc: Document,
  targetLanguage: string,
  rebuiltAt = new Date(),
) {
  if (!doc.documentElement) throw new Error("EPUB package document is missing");
  const epub3 = doc.documentElement.getAttribute("version")?.startsWith("3") ?? false;
  // The OPF 2.0.1 DTD allows no xml:lang on <package>, and EPUBCheck fails the book over it.
  if (epub3) doc.documentElement.setAttributeNS(XML_NAMESPACE, "xml:lang", targetLanguage);
  let metadata: Element | undefined;
  const languages: Element[] = [];
  const modified: Element[] = [];
  const generators: Element[] = [];
  walkElements(doc.documentElement, (element) => {
    const name = localName(element).toLowerCase();
    if (name === "metadata" && !metadata) metadata = element;
    if (name === "language" && element.parentNode && localName(element.parentNode) === "metadata") {
      languages.push(element);
    }
    if (name !== "meta" || !element.parentNode || localName(element.parentNode) !== "metadata") {
      return;
    }
    const property = element.getAttribute("property");
    const metaName = element.getAttribute("name");
    if (property === "dcterms:modified" || metaName === "dcterms:modified") modified.push(element);
    if (metaName?.toLowerCase() === "generator") generators.push(element);
  });
  if (!metadata) throw new Error("EPUB package metadata is missing");

  if (languages.length) {
    for (const language of languages) language.textContent = targetLanguage;
  } else {
    const language = doc.createElementNS(DC_NAMESPACE, "dc:language");
    language.appendChild(doc.createTextNode(targetLanguage));
    metadata.appendChild(language);
  }

  const timestamp = rebuiltAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const entry of modified) {
    if (entry.hasAttribute("content")) entry.setAttribute("content", timestamp);
    else entry.textContent = timestamp;
  }
  if (!modified.length && epub3) {
    const entry = doc.createElementNS(metadata.namespaceURI, "meta");
    entry.setAttribute("property", "dcterms:modified");
    entry.appendChild(doc.createTextNode(timestamp));
    metadata.appendChild(entry);
  }

  for (const entry of generators) {
    if (entry.hasAttribute("content")) entry.setAttribute("content", FILE_GENERATOR);
    else entry.textContent = FILE_GENERATOR;
  }
  if (!generators.length) {
    const entry = doc.createElementNS(metadata.namespaceURI, "meta");
    entry.setAttribute("name", "generator");
    entry.setAttribute("content", FILE_GENERATOR);
    metadata.appendChild(entry);
  }
}

export function updateContentLanguage(doc: Document, targetLanguage: string) {
  const root = doc.documentElement;
  if (!root) throw new Error("EPUB content document is missing");
  const isHtml = localName(root).toLowerCase() === "html";
  walkElements(root, (element) => {
    if (element === root || element.hasAttribute("xml:lang")) {
      element.setAttributeNS(XML_NAMESPACE, "xml:lang", targetLanguage);
    }
    if (isHtml && (element === root || element.hasAttribute("lang"))) {
      element.setAttribute("lang", targetLanguage);
    }
  });
}
