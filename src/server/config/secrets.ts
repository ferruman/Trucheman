import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export type SecretStore = Readonly<{
  translationApiKey?: string;
  editingApiKey?: string;
  criticApiKey?: string;
  consistencyApiKey?: string;
  translationEndpoint?: string;
  translationTransport?: string;
  editingEndpoint?: string;
  editingTransport?: string;
  criticEndpoint?: string;
  criticTransport?: string;
  consistencyEndpoint?: string;
  consistencyTransport?: string;
  translationModel?: string;
  editingModel?: string;
  criticModel?: string;
  criticThinking?: string;
  repairModel?: string;
  repairThinking?: string;
  consistencyModel?: string;
  consistencyThinking?: string;
  editingPromptVersion?: string;
  concurrency?: string;
  timeoutMs?: string;
}>;
export function loadSecrets(path?: string): SecretStore {
  let text = "";
  const configuredPath =
    process.env.TRUCHEMAN_SECRETS_FILE ?? process.env.BOOK_TRANSLATOR_SECRETS_FILE;
  for (const candidate of path
    ? [path]
    : [configuredPath, resolve(process.cwd(), ".env.local"), resolve(process.cwd(), ".env")].filter(
        (value): value is string => Boolean(value),
      )) {
    try {
      text = readFileSync(candidate, "utf8");
      break;
    } catch {
      continue;
    }
  }
  if (!text) return Object.freeze({});
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) values[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  const value = (name: string) =>
    values[`TRUCHEMAN_${name}`] || values[`BOOK_TRANSLATOR_${name}`] || undefined;
  return Object.freeze({
    translationApiKey: value("TRANSLATION_API_KEY"),
    editingApiKey: value("EDITING_API_KEY"),
    criticApiKey: value("CRITIC_API_KEY"),
    consistencyApiKey: value("CONSISTENCY_API_KEY"),
    translationEndpoint: value("TRANSLATION_ENDPOINT"),
    translationTransport: value("TRANSLATION_TRANSPORT"),
    editingEndpoint: value("EDITING_ENDPOINT"),
    editingTransport: value("EDITING_TRANSPORT"),
    criticEndpoint: value("CRITIC_ENDPOINT"),
    criticTransport: value("CRITIC_TRANSPORT"),
    consistencyEndpoint: value("CONSISTENCY_ENDPOINT"),
    consistencyTransport: value("CONSISTENCY_TRANSPORT"),
    translationModel: value("TRANSLATION_MODEL"),
    editingModel: value("EDITING_MODEL"),
    criticModel: value("CRITIC_MODEL"),
    criticThinking: value("CRITIC_THINKING"),
    repairModel: value("REPAIR_MODEL"),
    repairThinking: value("REPAIR_THINKING"),
    consistencyModel: value("CONSISTENCY_MODEL"),
    consistencyThinking: value("CONSISTENCY_THINKING"),
    editingPromptVersion: value("EDITING_PROMPT_VERSION"),
    concurrency: value("CONCURRENCY"),
    timeoutMs: value("TIMEOUT_MS"),
  });
}
