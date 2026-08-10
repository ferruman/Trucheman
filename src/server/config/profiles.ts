import { loadSecrets, type SecretStore } from "./secrets.js";
import type { ProviderProfile } from "../providers/provider.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const TERRA_MODEL = "gpt-5.6-terra";

export type ResolvedProfiles = {
  useExternal: boolean;
  translation: ProviderProfile;
  editing: ProviderProfile;
  critic: ProviderProfile;
  consistency: ProviderProfile;
};

function thinkingMode(
  value: string | undefined,
  endpoint: string,
  variable: string,
): ProviderProfile["thinking"] {
  const configured = value ?? (endpoint.includes("api.deepseek.com") ? "disabled" : undefined);
  if (configured !== undefined && configured !== "enabled" && configured !== "disabled") {
    throw new Error(`${variable} must be enabled or disabled`);
  }
  return configured;
}

export function defaultEditingPromptVersion(model: string): ProviderProfile["promptVersion"] {
  const baseModel = model.toLocaleLowerCase().split("/").at(-1);
  return baseModel === TERRA_MODEL ? "literary-v3.2.1" : undefined;
}

/**
 * Single source of truth for provider configuration: the pipeline runs against it and the
 * settings endpoint reports it, so what the UI shows is always what a run would use.
 */
export function resolveProfiles(
  env: NodeJS.ProcessEnv = process.env,
  secrets: SecretStore = loadSecrets(),
): ResolvedProfiles {
  const useExternal =
    env.BOOK_TRANSLATOR_PROVIDER !== "deterministic" &&
    Boolean(secrets.translationApiKey && secrets.editingApiKey);
  const translationEndpoint =
    secrets.translationEndpoint ?? env.BOOK_TRANSLATOR_TRANSLATION_ENDPOINT ?? DEEPSEEK_ENDPOINT;
  const editingEndpoint =
    secrets.editingEndpoint ?? env.BOOK_TRANSLATOR_EDITING_ENDPOINT ?? DEEPSEEK_ENDPOINT;
  const criticEndpoint =
    secrets.criticEndpoint ?? env.BOOK_TRANSLATOR_CRITIC_ENDPOINT ?? editingEndpoint;
  const consistencyEndpoint =
    secrets.consistencyEndpoint ?? env.BOOK_TRANSLATOR_CONSISTENCY_ENDPOINT ?? translationEndpoint;
  const editingModel = secrets.editingModel ?? env.BOOK_TRANSLATOR_EDITING_MODEL ?? DEEPSEEK_MODEL;
  const editingPromptVersion =
    secrets.editingPromptVersion ?? env.BOOK_TRANSLATOR_EDITING_PROMPT_VERSION;
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
      model: editingModel,
      apiKey: secrets.editingApiKey,
      thinking: editingEndpoint.includes("api.deepseek.com") ? "disabled" : undefined,
      promptVersion: editingPromptVersion || defaultEditingPromptVersion(editingModel),
    },
    critic: {
      name: useExternal ? "critic" : "deterministic-local",
      endpoint: criticEndpoint,
      model: secrets.criticModel ?? env.BOOK_TRANSLATOR_CRITIC_MODEL ?? editingModel,
      apiKey: secrets.criticApiKey ?? secrets.editingApiKey,
      thinking: thinkingMode(
        secrets.criticThinking ?? env.BOOK_TRANSLATOR_CRITIC_THINKING,
        criticEndpoint,
        "BOOK_TRANSLATOR_CRITIC_THINKING",
      ),
    },
    consistency: {
      name: useExternal ? "consistency" : "deterministic-local",
      endpoint: consistencyEndpoint,
      model: secrets.consistencyModel ?? env.BOOK_TRANSLATOR_CONSISTENCY_MODEL ?? translation.model,
      apiKey: secrets.consistencyApiKey ?? secrets.translationApiKey,
      thinking: thinkingMode(
        secrets.consistencyThinking ?? env.BOOK_TRANSLATOR_CONSISTENCY_THINKING,
        consistencyEndpoint,
        "BOOK_TRANSLATOR_CONSISTENCY_THINKING",
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
    critic: view(profiles.critic),
    consistency: view(profiles.consistency),
  };
}
