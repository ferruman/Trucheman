import { describe, expect, it } from "vitest";
import { parseXml, serializeXml } from "../../src/server/epub/xml-dom.js";
import {
  extractTextSegments,
  mergeLogicalBlocks,
  reinsertText,
} from "../../src/server/epub/text-segments.js";
describe("text segments", () => {
  it("extracts visible text and preserves whitespace", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body> Hello <span>world</span><script>hidden</script><pre>code</pre></body></html>`,
    );
    const s = extractTextSegments(d, "doc");
    expect(s.map((x) => x.text)).toEqual([" Hello ", "world"]);
    expect(s[0].leading).toBe(" ");
  });
  it("merges a heading fragmented into one span per word into a single unit", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1><span>Down</span> <span>the</span> <span>Rabbit-Hole</span></h1><p>Alice was <em>very tired</em>.</p></body></html>`,
    );
    const { units, absorbed } = mergeLogicalBlocks(extractTextSegments(d, "doc"));

    // Decorative `<em>` no longer splits the public-domain sentence.
    expect(units.map((unit) => unit.text)).toEqual([
      "Down the Rabbit-Hole",
      "Alice was very tired.",
    ]);
    expect(absorbed.size).toBe(4);
    expect([...absorbed.values()]).toEqual([units[0].id, units[0].id, units[1].id, units[1].id]);
  });

  it("never pulls a sentence into the emphasis that starts it", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p><i>Dinah</i> sailed at dawn.</p></body></html>`,
    );
    const { units, absorbed } = mergeLogicalBlocks(extractTextSegments(d, "doc"));

    // Merging outward is safe; merging inward would italicise the whole paragraph.
    expect(units.map((unit) => unit.text)).toEqual(["Dinah", " sailed at dawn."]);
    expect(absorbed.size).toBe(0);
  });

  it("merges a fragmented entry wrapped in a single link", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><ol><li><a href="c.xhtml"><span>Part</span> <span>5</span> <span>Little</span> <span>Birds</span></a></li><li><a href="d.xhtml">Epilogue</a> — <em>note</em></li></ol></body></html>`,
    );
    const { units } = mergeLogicalBlocks(extractTextSegments(d, "doc"));

    // The link wraps the whole entry, so nothing distinguishes its four spans. The link
    // itself stays a boundary — its text is what the href points at — while the trailing
    // `<em>` merges into the run beside it.
    expect(units.map((unit) => unit.text)).toEqual(["Part 5 Little Birds", "Epilogue", " — note"]);
  });

  it("joins fragments without manufacturing space before punctuation", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>The <i>Dinah</i>, he says, and the <i>Dinah</i>'s crew. <span>Part</span> <span>5</span></p></body></html>`,
    );
    const { units } = mergeLogicalBlocks(extractTextSegments(d, "doc"));

    expect(units[0].text).toBe("The Dinah, he says, and the Dinah's crew. Part 5");
  });

  it("rejoins a capital split from the rest of a word by small-caps markup", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>A<small>LICE:</small> C<small>URIOUSER AND CURIOUSER!</small></p><p>R<small>ABBIT:</small> O<small>H DEAR!</small></p></body></html>`,
    );
    const { units } = mergeLogicalBlocks(extractTextSegments(d, "doc"));

    expect(units.map((unit) => unit.text)).toEqual([
      "ALICE: CURIOUSER AND CURIOUSER!",
      "RABBIT: OH DEAR!",
    ]);
  });

  it("never merges across a line break or a nested block", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p><span>First</span><br/><span>Second</span></p><div>Lead<p>Inner</p>Tail</div></body></html>`,
    );
    const { units } = mergeLogicalBlocks(extractTextSegments(d, "doc"));

    expect(units.map((unit) => unit.text)).toEqual(["First", "Second", "Lead", "Inner", "Tail"]);
  });

  it("writes the whole block into the first node and empties the rest", () => {
    const d = parseXml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1><span>In</span> <span>the</span> <span>Desert</span></h1></body></html>`,
    );
    const segments = extractTextSegments(d, "doc");
    const { units, absorbed } = mergeLogicalBlocks(segments);
    const values = new Map<string, string>([[units[0].id, "Вниз по кроличьей норе"]]);
    for (const id of absorbed.keys()) values.set(id, "");

    reinsertText(d, segments, values);
    const text = d.documentElement.textContent;
    expect(text.trim()).toBe("Вниз по кроличьей норе");
  });

  it("reinserts only the original text node", () => {
    const d = parseXml(`<html><body>Hello</body></html>`);
    const s = extractTextSegments(d, "doc");
    reinsertText(d, s, new Map([[s[0].id, "Bonjour"]]));
    expect(serializeXml(d)).toContain("Bonjour");
  });
});
