import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedJob } from "../../src/server/domain/job.js";
import { buildJobInstructions, runPreparedBook } from "../../src/server/jobs/book-pipeline.js";
import { buildFixtureEpub } from "../fixtures/build-epubs.js";

const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

describe("book pipeline instructions",()=>{
  it("includes the selected language pair and custom instructions",()=>{
    expect(buildJobInstructions({sourceLanguage:"en",targetLanguage:"ru",instructions:"Keep names unchanged."})).toBe("Translate from en to ru.\nKeep names unchanged.");
  });

  it("rebuilds from a clean source and reuses checkpoints on repeated runs",async()=>{
    vi.stubEnv("BOOK_TRANSLATOR_PROVIDER","deterministic");
    const root=await mkdtemp(`${tmpdir()}/book-pipeline-rerun-`);roots.push(root);
    await buildFixtureEpub(join(root,"source.epub"));
    const now=new Date().toISOString();
    const job:PersistedJob={version:1,id:"12345678-1234-4234-8234-123456789012",title:"Book",sourceLanguage:"en",targetLanguage:"ru",status:"ready",stage:"translation",progress:{translated:0,edited:0,total:1,failed:0},createdAt:now,updatedAt:now,warnings:0,documents:[],instructions:"",glossary:[]};
    await runPreparedBook(root,job,async()=>undefined);
    const firstDrafts=await readFile(join(root,"drafts.ndjson"),"utf8"),firstEdits=await readFile(join(root,"edits.ndjson"),"utf8");
    await expect(runPreparedBook(root,job,async()=>undefined)).resolves.toMatchObject({ok:true});
    expect(await readFile(join(root,"drafts.ndjson"),"utf8")).toBe(firstDrafts);
    expect(await readFile(join(root,"edits.ndjson"),"utf8")).toBe(firstEdits);
  });
});
