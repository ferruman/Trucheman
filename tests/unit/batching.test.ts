import { describe, expect, it } from "vitest";
import { makeBatches } from "../../src/server/epub/batcher.js";
describe("batching",()=>{
  it("keeps batches within the configured character budget",()=>{const segments=Array.from({length:5},(_,i)=>({id:`d:${i}`,text:"x".repeat(6),sourceHash:"",locator:[i],leading:"",trailing:""}));const batches=makeBatches(segments,10);expect(batches.length).toBe(5);expect(batches.flatMap(x=>x.segments)).toHaveLength(5);});
  it("creates globally distinct checkpoint IDs for different documents",()=>{const segment=(id:string)=>({id,text:"text",sourceHash:"",locator:[0],leading:"",trailing:""});const first=makeBatches([segment("document-1:0")]),second=makeBatches([segment("document-2:0")]);expect(first[0].id).not.toBe(second[0].id);expect(first[0].documentId).toBe("document-1");expect(second[0].documentId).toBe("document-2");});
});
