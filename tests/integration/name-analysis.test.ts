import { describe, expect, it } from "vitest";
import { canonicalizeNames, relevantGlossary } from "../../src/server/providers/name-analysis.js";
describe("name analysis",()=>it("deduplicates aliases and selects relevant entries",()=>{const entries=canonicalizeNames([{id:"1",source:"Alice",target:"Alisa",category:"person",enabled:true},{id:"2",source:"alice",target:"Alisa",category:"person",enabled:true}]);expect(entries).toHaveLength(1);expect(relevantGlossary(entries,"Alice entered")).toHaveLength(1);}));
