import type { Document, Element, Node } from "@xmldom/xmldom";
import { localName } from "./xml-dom.js";

const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

function walkElements(node: Node, visit: (element: Element) => void) {
  if (node.nodeType === 1) visit(node as Element);
  for (let child = node.firstChild; child; child = child.nextSibling) {
    walkElements(child, visit);
  }
}

export function updatePackageLanguage(doc: Document, targetLanguage: string) {
  if (!doc.documentElement) throw new Error("EPUB package document is missing");
  let metadata: Element | undefined;
  const languages: Element[] = [];
  walkElements(doc.documentElement, (element) => {
    const name = localName(element).toLowerCase();
    if (name === "metadata" && !metadata) metadata = element;
    if (name === "language" && element.parentNode && localName(element.parentNode) === "metadata") {
      languages.push(element);
    }
  });
  if (!metadata) throw new Error("EPUB package metadata is missing");

  if (languages.length) {
    for (const language of languages) language.textContent = targetLanguage;
    return;
  }

  const language = doc.createElementNS(DC_NAMESPACE, "dc:language");
  language.appendChild(doc.createTextNode(targetLanguage));
  metadata.appendChild(language);
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
