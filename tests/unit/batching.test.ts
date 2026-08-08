import { describe, expect, it } from "vitest";
import { makeBatches } from "../../src/server/epub/batcher.js";
describe("batching",()=>{it("keeps batches within the configured character budget",()=>{const segments=Array.from({length:5},(_,i)=>({id:`d:${i}`,text:"x".repeat(6),sourceHash:"",locator:[i],leading:"",trailing:""}));const batches=makeBatches(segments,10);expect(batches.length).toBe(5);expect(batches.flatMap(x=>x.segments)).toHaveLength(5);});});
