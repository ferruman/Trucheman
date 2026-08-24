import { describe, expect, it } from "vitest";
import {
  defaultEditingPromptVersion,
  profilesView,
  resolveProfiles,
} from "../../src/server/config/profiles.js";

describe("settings API boundary", () => {
  it("reports endpoint and model but never the credential itself", () => {
    const view = profilesView({
      useExternal: true,
      postRepairAudit: false,
      concurrency: 4,
      translation: {
        name: "deepseek-translation",
        endpoint: "https://example.test/chat",
        model: "some-model",
        apiKey: "sk-secret-value",
      },
      editing: {
        name: "deepseek-editing",
        endpoint: "https://example.test/chat",
        model: "other-model",
        apiKey: "sk-secret-value",
      },
      critic: {
        name: "critic",
        endpoint: "https://example.test/chat",
        model: "critic-model",
        apiKey: "sk-secret-value",
      },
      repair: {
        name: "deepseek-repair",
        endpoint: "https://example.test/chat",
        model: "repair-model",
        apiKey: "sk-secret-value",
      },
      consistency: {
        name: "consistency",
        endpoint: "https://example.test/chat",
        model: "some-model",
      },
    });
    expect(view.translation).toEqual({
      endpoint: "https://example.test/chat",
      model: "some-model",
      hasApiKey: true,
    });
    expect(view.consistency.hasApiKey).toBe(false);
    expect(view.critic.model).toBe("critic-model");
    expect(view.repair.model).toBe("repair-model");
    expect(JSON.stringify(view)).not.toContain("sk-secret-value");
  });

  it("keeps repair on the editing model until it is given one of its own", () => {
    const shared = resolveProfiles({ BOOK_TRANSLATOR_EDITING_MODEL: "flash" }, {});
    expect(shared.repair.model).toBe("flash");
    expect(shared.repair.endpoint).toBe(shared.editing.endpoint);
    const split = resolveProfiles(
      { BOOK_TRANSLATOR_EDITING_MODEL: "flash", BOOK_TRANSLATOR_REPAIR_MODEL: "pro" },
      {},
    );
    expect([split.editing.model, split.repair.model]).toEqual(["flash", "pro"]);
    // The .env file wins over the ambient environment, like every other setting here.
    expect(
      resolveProfiles({ BOOK_TRANSLATOR_REPAIR_MODEL: "pro" }, { repairModel: "terra" }).repair
        .model,
    ).toBe("terra");
  });

  it("prefers Trucheman provider variables while accepting the legacy prefix", () => {
    const profiles = resolveProfiles(
      { TRUCHEMAN_EDITING_MODEL: "current", BOOK_TRANSLATOR_EDITING_MODEL: "legacy" },
      {},
    );
    expect(profiles.editing.model).toBe("current");
    expect(resolveProfiles({ BOOK_TRANSLATOR_EDITING_MODEL: "legacy" }, {}).editing.model).toBe(
      "legacy",
    );
  });

  it("falls back to the deterministic provider when credentials are absent", () => {
    const profiles = resolveProfiles({ BOOK_TRANSLATOR_PROVIDER: "deterministic" });
    expect(profiles.useExternal).toBe(false);
    expect(profilesView(profiles).provider).toBe("deterministic");
  });

  it("keeps the second critic pass off unless it is explicitly enabled", () => {
    expect(resolveProfiles({}).postRepairAudit).toBe(false);
    expect(resolveProfiles({ BOOK_TRANSLATOR_POST_REPAIR_AUDIT: "0" }).postRepairAudit).toBe(false);
    expect(resolveProfiles({ BOOK_TRANSLATOR_POST_REPAIR_AUDIT: "1" }).postRepairAudit).toBe(true);
  });

  it("rejects a batch concurrency a run could not honour instead of silently defaulting", () => {
    expect(resolveProfiles({}, {}).concurrency).toBe(4);
    expect(
      profilesView(resolveProfiles({ BOOK_TRANSLATOR_CONCURRENCY: "6" }, {})).concurrency,
    ).toBe(6);
    expect(resolveProfiles({ BOOK_TRANSLATOR_CONCURRENCY: "8" }, {}).concurrency).toBe(8);
    // The .env file wins over the ambient environment, like every other setting here.
    expect(
      resolveProfiles({ BOOK_TRANSLATOR_CONCURRENCY: "8" }, { concurrency: "2" }).concurrency,
    ).toBe(2);
    for (const value of ["0", "-1", "2.5", "many", "99"])
      expect(() => resolveProfiles({ BOOK_TRANSLATOR_CONCURRENCY: value }, {})).toThrow(
        /TRUCHEMAN_CONCURRENCY/,
      );
  });

  it("applies one request timeout to every stage", () => {
    // 60s was hard-coded in the provider with no way to raise it, so a slow model on a full
    // batch expired and paid for the whole prompt again.
    const byDefault = resolveProfiles({}, {});
    expect(
      [byDefault.translation, byDefault.editing, byDefault.critic, byDefault.consistency].map(
        (profile) => profile.timeoutMs,
      ),
    ).toEqual([60000, 60000, 60000, 60000]);

    const raised = resolveProfiles({ BOOK_TRANSLATOR_TIMEOUT_MS: "180000" }, {});
    expect(raised.translation.timeoutMs).toBe(180000);
    expect(raised.consistency.timeoutMs).toBe(180000);
    // The .env file wins over the ambient environment, like every other setting here.
    expect(
      resolveProfiles({ BOOK_TRANSLATOR_TIMEOUT_MS: "180000" }, { timeoutMs: "90000" }).editing
        .timeoutMs,
    ).toBe(90000);
    for (const value of ["0", "999", "1.5", "soon", "600001"])
      expect(() => resolveProfiles({ BOOK_TRANSLATOR_TIMEOUT_MS: value }, {})).toThrow(
        /TRUCHEMAN_TIMEOUT_MS/,
      );
  });

  it("selects the evaluated editor prompt for Terra without changing other model defaults", () => {
    expect(defaultEditingPromptVersion("gpt-5.6-terra")).toBe("literary-v3.2.1");
    expect(defaultEditingPromptVersion("openai/gpt-5.6-terra")).toBe("literary-v3.2.1");
    expect(defaultEditingPromptVersion("deepseek-v4-flash")).toBeUndefined();
  });

  it("allows the critic model to diverge from the editor while inheriting its transport", () => {
    const profiles = resolveProfiles(
      {
        BOOK_TRANSLATOR_PROVIDER: "deterministic",
        BOOK_TRANSLATOR_EDITING_ENDPOINT: "https://example.test/chat",
        BOOK_TRANSLATOR_EDITING_MODEL: "editor-model",
        BOOK_TRANSLATOR_CRITIC_ENDPOINT: "https://critic.example/chat",
        BOOK_TRANSLATOR_CRITIC_MODEL: "critic-model",
      },
      {},
    );
    expect(profiles.critic).toMatchObject({
      endpoint: "https://critic.example/chat",
      model: "critic-model",
    });
  });

  it("only applies DeepSeek transport defaults to the actual DeepSeek hostname", () => {
    const trusted = resolveProfiles(
      { BOOK_TRANSLATOR_TRANSLATION_ENDPOINT: "https://api.deepseek.com/v1" },
      {},
    );
    const lookalike = resolveProfiles(
      { BOOK_TRANSLATOR_TRANSLATION_ENDPOINT: "https://api.deepseek.com.evil.example/v1" },
      {},
    );
    expect(trusted.translation.thinking).toBe("disabled");
    expect(lookalike.translation.thinking).toBeUndefined();
  });
});
