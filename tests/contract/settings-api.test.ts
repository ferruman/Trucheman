import { describe, expect, it } from "vitest";
import { SettingsRepository } from "../../src/server/storage/settings-repository.js";
describe("settings API boundary",()=>it("returns current model defaults and credential presence rather than values",async()=>{const settings=await new SettingsRepository("/tmp/book-translator-missing/settings.json").get();expect(settings.translation.model).toBe("deepseek-v4-flash");expect(settings.editing.model).toBe("deepseek-v4-flash");expect(settings.translation).toHaveProperty("hasApiKey");expect(settings.translation).not.toHaveProperty("apiKey");}));
