import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export type SecretStore = Readonly<{
  translationApiKey?: string;
  editingApiKey?: string;
  criticApiKey?: string;
  consistencyApiKey?: string;
  translationEndpoint?: string;
  editingEndpoint?: string;
  criticEndpoint?: string;
  consistencyEndpoint?: string;
  translationModel?: string;
  editingModel?: string;
  criticModel?: string;
  criticThinking?: string;
  consistencyModel?: string;
  consistencyThinking?: string;
  editingPromptVersion?: string;
}>;
export function loadSecrets(path?: string): SecretStore {
  let text = "";
  for (const candidate of path
    ? [path]
    : [resolve(process.cwd(), ".env.local"), resolve(process.cwd(), ".env")]) {
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
  return Object.freeze({
    translationApiKey: values.BOOK_TRANSLATOR_TRANSLATION_API_KEY || undefined,
    editingApiKey: values.BOOK_TRANSLATOR_EDITING_API_KEY || undefined,
    criticApiKey: values.BOOK_TRANSLATOR_CRITIC_API_KEY || undefined,
    consistencyApiKey: values.BOOK_TRANSLATOR_CONSISTENCY_API_KEY || undefined,
    translationEndpoint: values.BOOK_TRANSLATOR_TRANSLATION_ENDPOINT || undefined,
    editingEndpoint: values.BOOK_TRANSLATOR_EDITING_ENDPOINT || undefined,
    criticEndpoint: values.BOOK_TRANSLATOR_CRITIC_ENDPOINT || undefined,
    consistencyEndpoint: values.BOOK_TRANSLATOR_CONSISTENCY_ENDPOINT || undefined,
    translationModel: values.BOOK_TRANSLATOR_TRANSLATION_MODEL || undefined,
    editingModel: values.BOOK_TRANSLATOR_EDITING_MODEL || undefined,
    criticModel: values.BOOK_TRANSLATOR_CRITIC_MODEL || undefined,
    criticThinking: values.BOOK_TRANSLATOR_CRITIC_THINKING || undefined,
    consistencyModel: values.BOOK_TRANSLATOR_CONSISTENCY_MODEL || undefined,
    consistencyThinking: values.BOOK_TRANSLATOR_CONSISTENCY_THINKING || undefined,
    editingPromptVersion: values.BOOK_TRANSLATOR_EDITING_PROMPT_VERSION || undefined,
  });
}
