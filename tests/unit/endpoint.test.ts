import { describe, expect, it } from "vitest";
import { isEndpointHost } from "../../src/server/config/endpoint.js";

describe("provider endpoint host matching", () => {
  it("matches the parsed hostname, including URLs with an explicit port", () => {
    expect(isEndpointHost("https://api.deepseek.com/chat/completions", "api.deepseek.com")).toBe(
      true,
    );
    expect(isEndpointHost("https://api.deepseek.com:443/v1", "api.deepseek.com")).toBe(true);
  });

  it("rejects credentials, paths, and suffixes that only contain the trusted hostname", () => {
    for (const endpoint of [
      "https://api.deepseek.com@evil.example/v1",
      "https://evil.example/api.deepseek.com/v1",
      "https://api.deepseek.com.evil.example/v1",
      "not a url containing api.deepseek.com",
    ]) {
      expect(isEndpointHost(endpoint, "api.deepseek.com")).toBe(false);
    }
  });
});
