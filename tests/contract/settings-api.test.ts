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
    expect(JSON.stringify(view)).not.toContain("sk-secret-value");
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
});
