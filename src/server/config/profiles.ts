import { loadSecrets, type SecretStore } from "./secrets.js";
import type { ProviderProfile } from "../providers/provider.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const TERRA_MODEL = "gpt-5.6-terra";

export type ResolvedProfiles = {
  useExternal: boolean;
  /** Opt-in second critic pass over repaired blocks. Off unless explicitly enabled. */
  postRepairAudit: boolean;
  /** Batches translated at once. The ceiling is the provider's rate limit, not ours. */
  concurrency: number;
  translation: ProviderProfile;
  editing: ProviderProfile;
  critic: ProviderProfile;
  /**
   * Repair rewrites the blocks the critic condemned. It followed the editing profile until a
   * run put a stronger critic in front of a weaker repairer and 34 of 205 repairs came back
   * word for word. Only the model is its own — same endpoint and key as editing, since the
   * case this exists for is a bigger model on the same provider.
   */
  repair: ProviderProfile;
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

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

function batchConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENCY)
    throw new Error(`BOOK_TRANSLATOR_CONCURRENCY must be an integer from 1 to ${MAX_CONCURRENCY}`);
  return parsed;
}

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;

/**
 * One knob for every stage. A slow reasoning model on a full batch routinely passes the
 * 60s default; each expiry costs a whole retry of a prompt that was already being answered.
 */
function requestTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > MAX_TIMEOUT_MS)
    throw new Error(`BOOK_TRANSLATOR_TIMEOUT_MS must be an integer from 1000 to ${MAX_TIMEOUT_MS}`);
  return parsed;
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
  const timeoutMs = requestTimeout(secrets.timeoutMs ?? env.BOOK_TRANSLATOR_TIMEOUT_MS);
  const translation: ProviderProfile = {
    name: useExternal ? "deepseek-translation" : "deterministic-local",
    endpoint: translationEndpoint,
    model: secrets.translationModel ?? env.BOOK_TRANSLATOR_TRANSLATION_MODEL ?? DEEPSEEK_MODEL,
    apiKey: secrets.translationApiKey,
    thinking: translationEndpoint.includes("api.deepseek.com") ? "disabled" : undefined,
    timeoutMs,
  };
  return {
    useExternal,
    postRepairAudit: env.BOOK_TRANSLATOR_POST_REPAIR_AUDIT === "1",
    concurrency: batchConcurrency(secrets.concurrency ?? env.BOOK_TRANSLATOR_CONCURRENCY),
    translation,
    editing: {
      name: useExternal ? "deepseek-editing" : "deterministic-local",
      endpoint: editingEndpoint,
      model: editingModel,
      apiKey: secrets.editingApiKey,
      thinking: editingEndpoint.includes("api.deepseek.com") ? "disabled" : undefined,
      promptVersion: editingPromptVersion || defaultEditingPromptVersion(editingModel),
      timeoutMs,
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
      timeoutMs,
    },
    repair: {
      name: useExternal ? "deepseek-repair" : "deterministic-local",
      endpoint: editingEndpoint,
      model: secrets.repairModel ?? env.BOOK_TRANSLATOR_REPAIR_MODEL ?? editingModel,
      apiKey: secrets.editingApiKey,
      thinking: thinkingMode(
        secrets.repairThinking ?? env.BOOK_TRANSLATOR_REPAIR_THINKING,
        editingEndpoint,
        "BOOK_TRANSLATOR_REPAIR_THINKING",
      ),
      promptVersion: editingPromptVersion || defaultEditingPromptVersion(editingModel),
      timeoutMs,
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
      timeoutMs,
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
    postRepairAudit: profiles.postRepairAudit,
    concurrency: profiles.concurrency,
    translation: view(profiles.translation),
    editing: view(profiles.editing),
    critic: view(profiles.critic),
    repair: view(profiles.repair),
    consistency: view(profiles.consistency),
  };
}
