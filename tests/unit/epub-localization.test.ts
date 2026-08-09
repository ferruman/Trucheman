import { describe, expect, it } from "vitest";
import {
  updateContentLanguage,
  updatePackageLanguage,
} from "../../src/server/epub/localization.js";
import { parseXml, serializeXml } from "../../src/server/epub/xml-dom.js";

describe("EPUB localization", () => {
  it("updates existing package languages and adds one when absent", () => {
    const existing = parseXml(
      `<package><metadata><dc:language xmlns:dc="http://purl.org/dc/elements/1.1/">en</dc:language></metadata></package>`,
    );
    updatePackageLanguage(existing, "ru");
    expect(serializeXml(existing)).toContain(">ru</dc:language>");
    expect(existing.documentElement.getAttribute("xml:lang")).toBe("ru");

    const absent = parseXml(`<package><metadata><title>Book</title></metadata></package>`);
    updatePackageLanguage(absent, "pl");
    expect(serializeXml(absent)).toContain(">pl</dc:language>");
    expect(absent.documentElement.getAttribute("xml:lang")).toBe("pl");
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
