import { describe, expect, it, vi } from "vitest";
import { ProviderGateway } from "../../src/server/providers/gateway.js";
import { ProviderRegistry, PROVIDER_TRANSPORTS } from "../../src/server/providers/registry.js";
import type {
  LanguageModelProvider,
  ProviderProfile,
  ProviderRequest,
} from "../../src/server/providers/provider.js";

const profile = (transport = "custom"): ProviderProfile => ({
  name: "test",
  transport,
  endpoint: "https://example.test/chat/completions",
  model: "model",
  apiKey: "secret",
});

const request = (requestProfile = profile()): ProviderRequest => ({
  profile: requestProfile,
  mode: "translation",
  sourceLanguage: { tag: "en", name: "English" },
  targetLanguage: { tag: "ru", name: "Russian" },
  segments: [{ id: "s1", text: "Hello" }],
});

function adapter() {
  return {
    complete: vi.fn(async () => ({ segments: [{ id: "s1", text: "Привет" }] })),
  } satisfies LanguageModelProvider;
}

describe("provider gateway", () => {
  it("routes a standard request by the profile transport and reuses its adapter", async () => {
    const provider = adapter();
    const create = vi.fn(() => provider);
    const registry = new ProviderRegistry([{ id: "custom", create }]);
    const gateway = new ProviderGateway({ root: "/tmp/job", useExternal: true, registry });

    await gateway.complete(request());
    await gateway.complete(request());

    expect(create).toHaveBeenCalledOnce();
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("owns deterministic and batch routing instead of exposing it to the pipeline", () => {
    const registry = new ProviderRegistry([
      { id: PROVIDER_TRANSPORTS.deterministic, create: adapter },
      { id: PROVIDER_TRANSPORTS.openAiBatch, create: adapter },
    ]);
    expect(
      new ProviderGateway({ root: "/tmp/job", useExternal: false, registry }).transportFor(
        profile(),
      ),
    ).toBe(PROVIDER_TRANSPORTS.deterministic);
    expect(
      new ProviderGateway({
        root: "/tmp/job",
        useExternal: true,
        executionMode: "batch",
        registry,
      }).transportFor(profile()),
    ).toBe(PROVIDER_TRANSPORTS.openAiBatch);
  });

  it("validates every selected profile before a run starts", () => {
    const validateProfile = vi.fn((candidate: ProviderProfile) => {
      if (!candidate.apiKey) throw new Error("missing key");
    });
    const registry = new ProviderRegistry([{ id: "custom", create: adapter, validateProfile }]);
    const gateway = new ProviderGateway({ root: "/tmp/job", useExternal: true, registry });

    expect(() =>
      gateway.validateProfiles([profile(), { ...profile(), apiKey: undefined }]),
    ).toThrow("missing key");
    expect(validateProfile).toHaveBeenCalledTimes(2);
  });

  it("reports an unknown transport as configuration, not a network failure", async () => {
    const gateway = new ProviderGateway({
      root: "/tmp/job",
      useExternal: true,
      registry: new ProviderRegistry(),
    });
    await expect(gateway.complete(request(profile("missing")))).rejects.toMatchObject({
      kind: "configuration",
    });
  });
});
