import { describe, expect, it } from "vitest";
import { selectRetryScope } from "../../src/server/jobs/retry-service.js";
describe("failure recovery",()=>it("selects only the requested chapter",()=>expect(selectRetryScope([{batchId:"a",chapterId:"one"},{batchId:"b",chapterId:"two"}],"two")).toEqual([{batchId:"b",chapterId:"two"}])));
