import { describe, expect, it } from "vitest";
import {
  updateContentLanguage,
  updatePackageLanguage,
} from "../../src/server/epub/localization.js";
import { parseXml, serializeXml } from "../../src/server/epub/xml-dom.js";

describe("EPUB localization", () => {
  it("updates existing package languages and adds one when absent", () => {
    const existing = parseXml(
      `<package version="3.0"><metadata><dc:language xmlns:dc="http://purl.org/dc/elements/1.1/">en</dc:language></metadata></package>`,
    );
    updatePackageLanguage(existing, "ru");
    expect(serializeXml(existing)).toContain(">ru</dc:language>");
    expect(existing.documentElement.getAttribute("xml:lang")).toBe("ru");

    const absent = parseXml(
      `<package version="3.0"><metadata><title>Book</title></metadata></package>`,
    );
    updatePackageLanguage(absent, "pl");
    expect(serializeXml(absent)).toContain(">pl</dc:language>");
    expect(absent.documentElement.getAttribute("xml:lang")).toBe("pl");
  });

  it("leaves xml:lang off an EPUB 2 package, whose DTD forbids it", () => {
    const doc = parseXml(
      `<package version="2.0"><metadata><dc:language xmlns:dc="http://purl.org/dc/elements/1.1/">en</dc:language></metadata></package>`,
    );
    updatePackageLanguage(doc, "ru");
    expect(serializeXml(doc)).toContain(">ru</dc:language>");
    expect(doc.documentElement.hasAttribute("xml:lang")).toBe(false);
  });

  it("keeps bibliographic metadata while refreshing output-file metadata", () => {
    const doc = parseXml(
      `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title><dc:creator>Author</dc:creator><dc:identifier>978-1-2345-6789-0</dc:identifier><dc:publisher>Publisher</dc:publisher><dc:date>1999</dc:date><dc:language>en</dc:language><meta property="dcterms:modified">1999-01-01T00:00:00Z</meta><meta name="generator" content="Calibre"/></metadata></package>`,
    );

    updatePackageLanguage(doc, "ru", new Date("2026-08-11T10:09:08.123Z"));
    const output = serializeXml(doc);

    expect(output).toContain("<dc:title>Book</dc:title>");
    expect(output).toContain("<dc:creator>Author</dc:creator>");
    expect(output).toContain("<dc:identifier>978-1-2345-6789-0</dc:identifier>");
    expect(output).toContain("<dc:publisher>Publisher</dc:publisher>");
    expect(output).toContain("<dc:date>1999</dc:date>");
    expect(output).toContain("<dc:language>ru</dc:language>");
    expect(output).toContain('property="dcterms:modified">2026-08-11T10:09:08Z</meta>');
    expect(output).toContain('name="generator" content="Book Translator"');
  });

  it("sets HTML language attributes and only xml:lang on NCX", () => {
    const html = parseXml(`<html><body><header lang="en" xml:lang="en"/></body></html>`);
    updateContentLanguage(html, "ru");
    expect(html.documentElement.getAttribute("lang")).toBe("ru");
    expect(html.documentElement.getAttribute("xml:lang")).toBe("ru");
    const header = html.getElementsByTagName("header").item(0)!;
    expect(header.getAttribute("lang")).toBe("ru");
    expect(header.getAttribute("xml:lang")).toBe("ru");

    const ncx = parseXml(`<ncx><navMap/></ncx>`);
    updateContentLanguage(ncx, "de");
    expect(ncx.documentElement.getAttribute("lang")).toBeNull();
    expect(ncx.documentElement.getAttribute("xml:lang")).toBe("de");
  });
});
