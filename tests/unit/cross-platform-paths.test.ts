import { describe, expect, it } from "vitest";
import { jobRoot, safeJobPath } from "../../src/server/storage/job-paths.js";
describe("cross-platform paths", () => {
  it("rejects unresolved separators", () =>
    expect(() => safeJobPath("/tmp/job", "..\\secret")).toThrow());
  it("contains a normal child path", () =>
    expect(safeJobPath("/tmp/job", "state.json")).toBe("/tmp/job/state.json"));
  it.each(["../secret", "/tmp/secret", ".", "nested/../../secret", "nested\0secret"])(
    "rejects a path outside the trusted root: %s",
    (candidate) => expect(() => safeJobPath("/tmp/job", candidate)).toThrow(),
  );
  it("contains a validated job UUID under the jobs directory", () => {
    expect(jobRoot("/tmp/data", "12345678-1234-4234-8234-123456789012")).toBe(
      "/tmp/data/jobs/12345678-1234-4234-8234-123456789012",
    );
  });
  it.each(["../../etc", "--------------------", "12345678-1234-1234-1234-123456789012"])(
    "rejects an invalid job id: %s",
    (id) => expect(() => jobRoot("/tmp/data", id)).toThrow(/Invalid job id/),
  );
});
