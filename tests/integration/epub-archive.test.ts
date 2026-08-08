import { describe, expect, it } from "vitest";
import { validateArchiveEntries } from "../../src/server/epub/archive-policy.js";
describe("EPUB archive safety",()=>it("rejects encrypted entries before extraction",()=>expect(()=>validateArchiveEntries([{fileName:"book",compressedSize:1,uncompressedSize:1,encrypted:true}])).toThrow()));
