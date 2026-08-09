import { describe, expect, it } from "vitest";
import { validateProviderResponse } from "../../src/server/providers/response-validator.js";

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
    ).toThrow("Provider response segments must contain string id and text fields");
  });

  it("rejects truncated responses", () => {
    expect(() =>
      validateProviderResponse({ segments: [{ id: "a", text: "ok" }], finishReason: "length" }, [
        { id: "a", text: "a" },
      ]),
    ).toThrow();
  });
});
