import { describe, expect, it } from "vitest";
import { SettingsRepository } from "../../src/server/storage/settings-repository.js";
describe("settings API boundary",()=>it("returns credential presence rather than credential values",async()=>{const settings=await new SettingsRepository("/tmp/book-translator-missing/settings.json").get();expect(settings.translation).toHaveProperty("hasApiKey");expect(settings.translation).not.toHaveProperty("apiKey");}));
