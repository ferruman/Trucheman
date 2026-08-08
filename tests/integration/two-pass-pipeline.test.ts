import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FakeProvider } from "../../src/server/providers/fake-provider.js";
import { runTwoPass } from "../../src/server/jobs/job-runner.js";
describe("two-pass pipeline",()=>it("persists drafts before edits in chapter order",async()=>{const root=await mkdtemp(`${tmpdir()}/book-translator-`),provider=new FakeProvider(),profile={name:"fake",endpoint:"local",model:"fake"};await runTwoPass([{id:"batch-1",documentId:"chapter-1",segments:[{id:"chapter-1:0",text:"Hello",sourceHash:"",locator:[],leading:"",trailing:""}]}],provider,{root,translationProfile:profile,editingProfile:profile});expect(provider.requests.map(x=>x.mode)).toEqual(["translation","editing"]);expect((await readFile(`${root}/drafts.ndjson`,`utf8`)).length).toBeGreaterThan(0);}));
