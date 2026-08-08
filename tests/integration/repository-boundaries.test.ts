import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JobRepository } from "../../src/server/storage/job-repository.js";
import { EventRepository } from "../../src/server/storage/event-repository.js";
import { SettingsRepository } from "../../src/server/storage/settings-repository.js";

function job(id:string){const now=new Date().toISOString();return {version:1 as const,id,title:"Boundary test",sourceLanguage:"en",targetLanguage:"pl",status:"created",stage:"import",progress:{translated:0,edited:0,total:0,failed:0},createdAt:now,updatedAt:now,warnings:0,documents:[],instructions:"",glossary:[]};}

describe("repository boundaries",()=>{
  it("rejects an invalid job before replacing valid persisted state",async()=>{const root=await mkdtemp(join(tmpdir(),"job-boundary-")),repo=new JobRepository(root),value=job("12345678-1234-4234-8234-123456789012");await repo.save(value);await expect(repo.save({...value,instructions:{} as never})).rejects.toThrow();expect((await repo.get(value.id)).instructions).toBe("");});

  it("scopes replay and live events to their job",async()=>{const root=await mkdtemp(join(tmpdir(),"event-boundary-")),repo=new EventRepository(join(root,"events.ndjson")),listener=vi.fn(),unsubscribe=repo.subscribe("job-a",listener);await repo.append({jobId:"job-b",type:"progress",timestamp:new Date().toISOString(),message:"other"});await repo.append({jobId:"job-a",type:"progress",timestamp:new Date().toISOString(),message:"mine"});unsubscribe();expect((await repo.list(0,"job-a")).map(event=>event.message)).toEqual(["mine"]);expect(listener).toHaveBeenCalledTimes(1);});

  it("derives credential presence without persisting credentials",async()=>{const root=await mkdtemp(join(tmpdir(),"settings-boundary-")),repo=new SettingsRepository(join(root,"settings.json"),{translation:true});const settings=await repo.get();expect(settings.translation.hasApiKey).toBe(true);await repo.save(settings);expect(await repo.get()).not.toHaveProperty("translation.apiKey");});
});
