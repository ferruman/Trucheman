import { describe, expect, it } from "vitest";
import { DeepSeekProvider } from "../../src/server/providers/deepseek.js";
describe("DeepSeek provider",()=>it("requires a server-side credential",async()=>await expect(new DeepSeekProvider().complete({profile:{name:"x",endpoint:"x",model:"x"},mode:"translation",segments:[]})).rejects.toMatchObject({kind:"configuration"})));
