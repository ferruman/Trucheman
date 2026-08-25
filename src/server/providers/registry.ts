import { FakeProvider } from "./fake-provider.js";
import { OpenAiBatchProvider, assertOpenAiBatchProfile } from "./openai-batch.js";
import { OpenAiChatProvider } from "./openai-chat.js";
import {
  PROVIDER_TRANSPORTS,
  ProviderError,
  type LanguageModelProvider,
  type ProviderProfile,
} from "./provider.js";

export { PROVIDER_TRANSPORTS } from "./provider.js";

export type ProviderAdapterContext = { root: string };

export type ProviderTransportDefinition = {
  id: string;
  create(context: ProviderAdapterContext): LanguageModelProvider;
  validateProfile?(profile: ProviderProfile): void;
};

/** Extensible transport catalogue. Adding an API protocol does not change the pipeline. */
export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderTransportDefinition>();

  constructor(definitions: ProviderTransportDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ProviderTransportDefinition): this {
    if (!definition.id.trim()) throw new Error("Provider transport id cannot be empty");
    if (this.definitions.has(definition.id)) {
      throw new Error(`Provider transport is already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
    return this;
  }

  resolve(id: string): ProviderTransportDefinition {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new ProviderError("configuration", `Unknown provider transport: ${id}`);
    }
    return definition;
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      id: PROVIDER_TRANSPORTS.deterministic,
      create: () => new FakeProvider(),
    },
    {
      id: PROVIDER_TRANSPORTS.openAiChat,
      create: () => new OpenAiChatProvider(),
    },
    {
      id: PROVIDER_TRANSPORTS.openAiBatch,
      create: ({ root }) => new OpenAiBatchProvider(root),
      validateProfile: assertOpenAiBatchProfile,
    },
  ]);
}
