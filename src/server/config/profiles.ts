import { loadSecrets } from "./secrets.js";
import type { ProviderProfile } from "../providers/provider.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";

export type ResolvedProfiles = {
  useExternal: boolean;
  translation: ProviderProfile;
  editing: ProviderProfile;
  consistency: ProviderProfile;
};

function thinkingMode(value: string | undefined, endpoint: string): ProviderProfile["thinking"] {
  const configured = value ?? (endpoint.includes("api.deepseek.com") ? "disabled" : undefined);
  if (configured !== undefined && configured !== "enabled" && configured !== "disabled") {
    throw new Error("BOOK_TRANSLATOR_CONSISTENCY_THINKING must be enabled or disabled");
  }
  return configured;
}

/**
 * Single source of truth for provider configuration: the pipeline runs against it and the
 * settings endpoint reports it, so what the UI shows is always what a run would use.
 */
export function resolveProfiles(env: NodeJS.ProcessEnv = process.env): ResolvedProfiles {
  const secrets = loadSecrets();
  const useExternal =
    env.BOOK_TRANSLATOR_PROVIDER !== "deterministic" &&
    Boolean(secrets.translationApiKey && secrets.editingApiKey);
  const translationEndpoint =
    secrets.translationEndpoint ?? env.BOOK_TRANSLATOR_TRANSLATION_ENDPOINT ?? DEEPSEEK_ENDPOINT;
  const editingEndpoint =
    secrets.editingEndpoint ?? env.BOOK_TRANSLATOR_EDITING_ENDPOINT ?? DEEPSEEK_ENDPOINT;
  const consistencyEndpoint =
    secrets.consistencyEndpoint ?? env.BOOK_TRANSLATOR_CONSISTENCY_ENDPOINT ?? translationEndpoint;
  const translation: ProviderProfile = {
    name: useExternal ? "deepseek-translation" : "deterministic-local",
    endpoint: translationEndpoint,
    model: secrets.translationModel ?? env.BOOK_TRANSLATOR_TRANSLATION_MODEL ?? DEEPSEEK_MODEL,
    apiKey: secrets.translationApiKey,
    thinking: translationEndpoint.includes("api.deepseek.com") ? "disabled" : undefined,
  };
  return {
    useExternal,
    translation,
    editing: {
      name: useExternal ? "deepseek-editing" : "deterministic-local",
      endpoint: editingEndpoint,
      model: secrets.editingModel ?? env.BOOK_TRANSLATOR_EDITING_MODEL ?? DEEPSEEK_MODEL,
      apiKey: secrets.editingApiKey,
      thinking: editingEndpoint.includes("api.deepseek.com") ? "disabled" : undefined,
      promptVersion: secrets.editingPromptVersion ?? env.BOOK_TRANSLATOR_EDITING_PROMPT_VERSION,
    },
    consistency: {
      name: useExternal ? "consistency" : "deterministic-local",
      endpoint: consistencyEndpoint,
      model: secrets.consistencyModel ?? env.BOOK_TRANSLATOR_CONSISTENCY_MODEL ?? translation.model,
      apiKey: secrets.consistencyApiKey ?? secrets.translationApiKey,
      thinking: thinkingMode(
        secrets.consistencyThinking ?? env.BOOK_TRANSLATOR_CONSISTENCY_THINKING,
        consistencyEndpoint,
      ),
    },
  };
}

/** Credential-free projection safe to send to the browser. */
export function profilesView(profiles: ResolvedProfiles = resolveProfiles()) {
  const view = (profile: ProviderProfile) => ({
    endpoint: profile.endpoint,
    model: profile.model,
    hasApiKey: Boolean(profile.apiKey),
  });
  return {
    provider: profiles.useExternal ? "external" : "deterministic",
    translation: view(profiles.translation),
    editing: view(profiles.editing),
    consistency: view(profiles.consistency),
  };
}
