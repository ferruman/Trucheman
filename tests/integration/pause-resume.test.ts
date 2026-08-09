import { describe, expect, it } from "vitest";
import { PauseController } from "../../src/server/jobs/pause-controller.js";
describe("pause controller", () =>
  it("stops scheduling after a pause request", () => {
    const controller = new PauseController();
    expect(controller.shouldPause).toBe(false);
    controller.requestPause();
    expect(controller.shouldPause).toBe(true);
    expect(() => controller.throwIfPaused()).toThrow();
  }));
