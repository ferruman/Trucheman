import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/server/config/schema.js";
describe("runtime configuration",()=>{it("uses safe loopback defaults",()=>{const config=parseConfig({});expect(config.host).toBe("127.0.0.1");expect(config.maxUploadBytes).toBe(100*1024*1024);});it("rejects an invalid port",()=>{expect(()=>parseConfig({BOOK_TRANSLATOR_PORT:"0"})).toThrow();});it("does not expose unknown environment values",()=>{const config=parseConfig({SECRET:"sentinel"});expect("SECRET" in config).toBe(false);});});
