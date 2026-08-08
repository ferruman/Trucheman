import { readFile, writeFile } from "node:fs/promises";
import { parseXml, serializeXml } from "./xml-dom.js";
import { extractTextSegments, reinsertText } from "./text-segments.js";
export async function reinsertDocument(path:string,values:Map<string,string>,documentId:string){const doc=parseXml(await readFile(path));const segments=extractTextSegments(doc,documentId);reinsertText(doc,segments,values);await writeFile(path,serializeXml(doc));return segments.length;}
