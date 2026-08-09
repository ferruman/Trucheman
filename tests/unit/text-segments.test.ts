import { describe, expect, it } from "vitest";
import { parseXml, serializeXml } from "../../src/server/epub/xml-dom.js";
import { extractTextSegments, reinsertText } from "../../src/server/epub/text-segments.js";
describe("text segments", () => {
  it("extracts visible text and preserves whitespace", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body> Hello <span>world</span><script>hidden</script><pre>code</pre></body></html>`,
    );
    const s = extractTextSegments(d, "doc");
    expect(s.map((x) => x.text)).toEqual([" Hello ", "world"]);
    expect(s[0].leading).toBe(" ");
  });
  it("reinserts only the original text node", () => {
    const d = parseXml(`<html><body>Hello</body></html>`);
    const s = extractTextSegments(d, "doc");
    reinsertText(d, s, new Map([[s[0].id, "Bonjour"]]));
    expect(serializeXml(d)).toContain("Bonjour");
  });
});
