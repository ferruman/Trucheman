import { describe, expect, it } from "vitest";
import { firstUnfinished } from "../../src/server/jobs/resume-plan.js";
describe("resume plan",()=>it("starts at the first unfinished step",()=>expect(firstUnfinished([{status:"completed"},{status:"pending"},{status:"pending"}])).toBe(1)));
