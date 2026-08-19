import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/server/config/schema.js";
describe("runtime configuration", () => {
  it("uses safe loopback defaults", () => {
    const config = parseConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.maxUploadBytes).toBe(100 * 1024 * 1024);
  });
  it("rejects an invalid port", () => {
    expect(() => parseConfig({ BOOK_TRANSLATOR_PORT: "0" })).toThrow();
  });
  it("prefers the Trucheman prefix while accepting the legacy prefix", () => {
    expect(parseConfig({ TRUCHEMAN_PORT: "4300", BOOK_TRANSLATOR_PORT: "4200" }).port).toBe(4300);
    expect(parseConfig({ BOOK_TRANSLATOR_PORT: "4200" }).port).toBe(4200);
  });
  it("does not expose unknown environment values", () => {
    const config = parseConfig({ SECRET: "sentinel" });
    expect("SECRET" in config).toBe(false);
  });
});
