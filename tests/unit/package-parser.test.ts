import { describe, expect, it } from "vitest";
import { parseContainer, parsePackage } from "../../src/server/epub/package-parser.js";
describe("EPUB package parsing", () => {
  it("follows container and declared spine order", () => {
    expect(parseContainer(`<container><rootfile full-path="OPS/book.opf"/></container>`)).toBe(
      "OPS/book.opf",
    );
    const book = parsePackage(
      `<package><manifest><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`,
      "OPS/book.opf",
    );
    expect(book.spine).toEqual(["a", "b"]);
  });
});
