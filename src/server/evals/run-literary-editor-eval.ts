import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadSecrets } from "../config/secrets.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { FakeProvider } from "../providers/fake-provider.js";
import type { LanguageModelProvider, ProviderProfile } from "../providers/provider.js";
import { PROMPT_VERSION } from "../providers/prompts.js";
import {
  evaluateLiteraryOutput,
  HUMAN_REVIEW_DIMENSIONS,
  literaryEditorCorpusSchema,
} from "./literary-editor-eval.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const corpusPath = resolve(argument("--corpus") ?? "evals/literary-editor/cases.json");
  const limitValue = argument("--limit");
  const providerName = argument("--provider") ?? "deepseek";
  const modelOverride = argument("--model");
  const thinking = argument("--thinking");
  if (!new Set(["deepseek", "deterministic"]).has(providerName)) {
    throw new Error("--provider must be deepseek or deterministic");
  }
  if (thinking !== undefined && !new Set(["enabled", "disabled"]).has(thinking)) {
    throw new Error("--thinking must be enabled or disabled");
  }
  if (providerName === "deterministic" && (modelOverride || thinking)) {
    throw new Error("--model and --thinking require --provider deepseek");
  }
  const limit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  const corpus = literaryEditorCorpusSchema.parse(JSON.parse(await readFile(corpusPath, "utf8")));
  const cases = limit ? corpus.cases.slice(0, limit) : corpus.cases;
  const secrets = loadSecrets();
  if (providerName === "deepseek" && !secrets.editingApiKey) {
    throw new Error("Editing provider credential is not configured");
  }

  const model =
    providerName === "deterministic"
      ? "fake"
      : (modelOverride ?? secrets.editingModel ?? "deepseek-chat");
  const runLabel = [PROMPT_VERSION, model, thinking].filter(Boolean).join("-");
  const outputPath = resolve(
    argument("--output") ?? `eval-results/literary-editor/${runLabel}-${timestamp()}.json`,
  );

  const profile: ProviderProfile =
    providerName === "deepseek"
      ? {
          name: "deepseek-literary-eval",
          endpoint: secrets.editingEndpoint ?? "https://api.deepseek.com/chat/completions",
          model,
          apiKey: secrets.editingApiKey,
          temperature: thinking === "enabled" ? undefined : 0,
          thinking: thinking as ProviderProfile["thinking"],
        }
      : { name: "deterministic-literary-eval", endpoint: "local", model: "fake" };
  const provider: LanguageModelProvider =
    providerName === "deepseek" ? new DeepSeekProvider() : new FakeProvider();
  const results = [];

  for (const testCase of cases) {
    try {
      const response = await provider.complete({
        profile,
        mode: "editing",
        sourceLanguage: testCase.sourceLanguage,
        targetLanguage: testCase.targetLanguage,
        instructions: testCase.instructions ?? "",
        glossary: [],
        segments: [{ id: testCase.id, original: testCase.original, draft: testCase.draft }],
      });
      const output = response.segments[0]?.text ?? "";
      const automated = evaluateLiteraryOutput(testCase, output);
      results.push({
        id: testCase.id,
        genre: testCase.genre,
        original: testCase.original,
        draft: testCase.draft,
        output,
        automated,
        humanReview: Object.fromEntries(
          HUMAN_REVIEW_DIMENSIONS.map((dimension) => [dimension, null]),
        ),
        reviewNotes: testCase.reviewNotes,
        requestId: response.requestId,
        usage: response.usage,
      });
      process.stdout.write(
        `${automated.passed ? "PASS" : "FAIL"} ${testCase.id} (${automated.passedChecks}/${automated.totalChecks})\n`,
      );
    } catch (error) {
      results.push({
        id: testCase.id,
        genre: testCase.genre,
        original: testCase.original,
        draft: testCase.draft,
        output: null,
        automated: null,
        humanReview: null,
        reviewNotes: testCase.reviewNotes,
        error: error instanceof Error ? error.message : "Unknown evaluation error",
      });
      process.stdout.write(`ERROR ${testCase.id}\n`);
    }
  }

  const completed = results.filter((result) => result.automated !== null);
  const passed = completed.filter((result) => result.automated?.passed).length;
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    corpus: { path: corpusPath, version: corpus.version, description: corpus.description },
    provider: {
      name: profile.name,
      endpoint: profile.endpoint,
      model: profile.model,
      temperature: profile.temperature,
      thinking: profile.thinking,
    },
    summary: {
      total: results.length,
      completed: completed.length,
      errors: results.length - completed.length,
      passed,
      passRate: completed.length ? passed / completed.length : 0,
    },
    results,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${outputPath}\n`);
}

await main();
