import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redact } from "../../src/server/domain/redaction.js";
import { loadSecrets } from "../../src/server/config/secrets.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("secret boundaries", () => {
  it("does not retain sentinel credentials in diagnostics", () => {
    expect(redact("Bearer sk-sentinel-secret")).not.toContain("sentinel");
  });

  it("loads the independent consistency provider profile", async () => {
    const root = await mkdtemp(`${tmpdir()}/book-secrets-`);
    roots.push(root);
    const path = join(root, ".env.local");
    await writeFile(
      path,
      [
        "BOOK_TRANSLATOR_CONSISTENCY_API_KEY=consistency-key",
        "BOOK_TRANSLATOR_CONSISTENCY_ENDPOINT=https://consistency.example/v1/chat/completions",
        "BOOK_TRANSLATOR_CONSISTENCY_MODEL=consistency-model",
        "BOOK_TRANSLATOR_CONSISTENCY_THINKING=enabled",
        "BOOK_TRANSLATOR_CRITIC_MODEL=critic-model",
        "BOOK_TRANSLATOR_CRITIC_API_KEY=critic-key",
        "BOOK_TRANSLATOR_CRITIC_ENDPOINT=https://critic.example/v1/chat/completions",
        "BOOK_TRANSLATOR_CRITIC_THINKING=disabled",
      ].join("\n"),
    );

    expect(loadSecrets(path)).toMatchObject({
      consistencyApiKey: "consistency-key",
      consistencyEndpoint: "https://consistency.example/v1/chat/completions",
      consistencyModel: "consistency-model",
      consistencyThinking: "enabled",
      criticModel: "critic-model",
      criticApiKey: "critic-key",
      criticEndpoint: "https://critic.example/v1/chat/completions",
      criticThinking: "disabled",
    });
  });
});
