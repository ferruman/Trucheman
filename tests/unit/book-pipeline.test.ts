import { describe, expect, it } from "vitest";
import { buildJobInstructions } from "../../src/server/jobs/book-pipeline.js";

describe("book pipeline instructions",()=>{
  it("includes the selected language pair and custom instructions",()=>{
    expect(buildJobInstructions({sourceLanguage:"en",targetLanguage:"ru",instructions:"Keep names unchanged."})).toBe("Translate from en to ru.\nKeep names unchanged.");
  });
});
