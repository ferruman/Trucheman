import { describe, expect, it } from "vitest";
import { safeJobPath } from "../../src/server/storage/job-paths.js";
describe("cross-platform paths", () => {
  it("rejects unresolved separators", () =>
    expect(() => safeJobPath("/tmp/job", "..\\secret")).toThrow());
  it("contains a normal child path", () =>
    expect(safeJobPath("/tmp/job", "state.json")).toBe("/tmp/job/state.json"));
  it.each(["../secret", "/tmp/secret", ".", "nested/../../secret", "nested\0secret"])(
    "rejects a path outside the trusted root: %s",
    (candidate) => expect(() => safeJobPath("/tmp/job", candidate)).toThrow(),
  );
});
