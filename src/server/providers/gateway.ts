import {
  createDefaultProviderRegistry,
  PROVIDER_TRANSPORTS,
  type ProviderRegistry,
} from "./registry.js";
import type {
  LanguageModelProvider,
  ProviderProfile,
  ProviderRequest,
  ProviderResponse,
} from "./provider.js";

export type ProviderGatewayOptions = {
  root: string;
  useExternal: boolean;
  executionMode?: "standard" | "batch";
  registry?: ProviderRegistry;
};

/** The only provider entry point used by application services. */
export class ProviderGateway implements LanguageModelProvider {
  private readonly registry: ProviderRegistry;
  private readonly providers = new Map<string, LanguageModelProvider>();

  constructor(private readonly options: ProviderGatewayOptions) {
    this.registry = options.registry ?? createDefaultProviderRegistry();
  }

  transportFor(profile: ProviderProfile): string {
    if (!this.options.useExternal) return PROVIDER_TRANSPORTS.deterministic;
    if (this.options.executionMode === "batch") return PROVIDER_TRANSPORTS.openAiBatch;
    return profile.transport ?? PROVIDER_TRANSPORTS.openAiChat;
  }

  validateProfiles(profiles: ProviderProfile[]): void {
    for (const profile of profiles) {
      const definition = this.registry.resolve(this.transportFor(profile));
      definition.validateProfile?.(profile);
    }
  }

  async complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    const transport = this.transportFor(request.profile);
    const definition = this.registry.resolve(transport);
    definition.validateProfile?.(request.profile);
    let provider = this.providers.get(transport);
    if (!provider) {
      provider = definition.create({ root: this.options.root });
      this.providers.set(transport, provider);
    }
    return await provider.complete(request, signal);
  }
}
