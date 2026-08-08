import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../src/server/providers/prompts.js";
import { validateProviderResponse } from "../../src/server/providers/response-validator.js";
describe("provider segment contract",()=>{it("keeps markup outside prompts and enforces IDs",()=>{const segments=[{id:"s1",text:"Hello"}];expect(buildPrompt({mode:"translation",segments})).toContain(`"id":"segment-id"`);expect(()=>validateProviderResponse({segments:[{id:"s2",text:"x"}]},segments)).toThrow();});});
