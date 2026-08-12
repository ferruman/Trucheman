import { describe, expect, it } from "vitest";
import {
  misalignedSegmentIds,
  validateProviderResponse,
} from "../../src/server/providers/response-validator.js";

describe("provider response validation", () => {
  it("requires exact ordered IDs", () => {
    const expected = [
      { id: "a", text: "one" },
      { id: "b", text: "two" },
    ];
    expect(
      validateProviderResponse({ segments: expected, finishReason: "stop" }, expected).segments,
    ).toEqual(expected);
    expect(() =>
      validateProviderResponse(
        { segments: [expected[1], expected[0]], finishReason: "stop" },
        expected,
      ),
    ).toThrow();
  });

  it("rejects malformed segments with a concise error", () => {
    expect(() =>
      validateProviderResponse({ segments: [{ id: "a", draft: "ok" }] as never }, [
        { id: "a", text: "source" },
      ]),
    ).toThrow("Provider response segments must contain non-empty string id and text fields");
  });

  it("rejects truncated responses", () => {
    expect(() =>
      validateProviderResponse({ segments: [{ id: "a", text: "ok" }], finishReason: "length" }, [
        { id: "a", text: "a" },
      ]),
    ).toThrow();
  });
});

describe("segment alignment", () => {
  const long = (marker: string, length: number) => marker.repeat(length);

  it("finds answers that carry the next segment's text", () => {
    // The shape taken from job 9c6c4e7c, batch document-10-batch-8: a sentence split over two
    // blocks is answered whole under the first id, and everything after it moves up one.
    const expected = [
      { id: "a", text: long("a", 120) },
      { id: "b", text: long("b", 60) },
      { id: "c", text: long("c", 300) },
      { id: "d", text: long("d", 100) },
    ];
    const shifted = [
      { id: "a", text: long("x", 180) },
      { id: "b", text: long("x", 300) },
      { id: "c", text: long("x", 100) },
      { id: "d", text: long("x", 100) },
    ];
    expect(misalignedSegmentIds(expected, shifted)).toEqual(["b", "c"]);
  });

  it("accepts an aligned batch, short segments and lopsided neighbours included", () => {
    const expected = [
      { id: "a", text: long("a", 120) },
      { id: "b", text: "Yes." },
      { id: "c", text: long("c", 300) },
      // Compressed hard, but its neighbour is no better a match, so nothing moved.
      { id: "d", text: long("d", 400) },
      { id: "e", text: long("e", 90) },
    ];
    const aligned = [
      { id: "a", text: long("x", 130) },
      { id: "b", text: "Да." },
      { id: "c", text: long("x", 320) },
      { id: "d", text: long("x", 150) },
      { id: "e", text: long("x", 95) },
    ];
    expect(misalignedSegmentIds(expected, aligned)).toEqual([]);
  });

  it("finds an answer that swallowed the next segment without shifting", () => {
    // Job 9cfcd03a, document-7:1p: the model answered both halves of the split sentence
    // under the first id and then answered the second id as well, so the glued half was
    // published twice. Nothing is out of order, so only the pair length gives it away.
    const expected = [
      { id: "a", text: long("a", 310) },
      { id: "b", text: long("b", 542) },
      { id: "c", text: long("c", 100) },
    ];
    expect(
      misalignedSegmentIds(expected, [
        { id: "a", text: long("x", 836) },
        { id: "b", text: long("x", 372) },
        { id: "c", text: long("x", 105) },
      ]),
    ).toEqual(["a"]);
  });

  it("keeps a segment whose tiny neighbour makes the pair length meaningless", () => {
    // own + next is barely more than own, so a perfectly ordinary answer lands in the band —
    // the length has to be unreasonable for the segment itself before that means anything.
    const expected = [
      { id: "a", text: long("a", 300) },
      { id: "b", text: long("b", 45) },
      { id: "c", text: long("c", 300) },
    ];
    expect(
      misalignedSegmentIds(expected, [
        { id: "a", text: long("x", 330) },
        { id: "b", text: long("x", 48) },
        { id: "c", text: long("x", 310) },
      ]),
    ).toEqual([]);
  });

  it("compares an editing answer against the draft it was given", () => {
    const expected = [
      { id: "a", original: long("o", 120), draft: long("a", 120) },
      { id: "b", original: long("o", 300), draft: long("b", 300) },
    ];
    expect(
      misalignedSegmentIds(expected, [
        { id: "a", text: long("x", 290) },
        { id: "b", text: long("x", 300) },
      ]),
    ).toEqual(["a"]);
  });
});
