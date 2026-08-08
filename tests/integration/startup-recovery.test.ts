import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { JobRepository } from "../../src/server/storage/job-repository.js";
import { recoverActiveJobs } from "../../src/server/jobs/recovery.js";
describe("startup recovery",()=>it("pauses stale active jobs",async()=>{const repo=new JobRepository(await mkdtemp(`${tmpdir()}/jobs-`));const now=new Date().toISOString();await repo.save({version:1,id:"12345678-1234-4234-8234-123456789012",title:"x",sourceLanguage:"en",targetLanguage:"ru",status:"running",stage:"translation",progress:{translated:0,edited:0,total:0,failed:0},createdAt:now,updatedAt:now,warnings:0,documents:[],instructions:"",glossary:[]});await recoverActiveJobs(repo);expect((await repo.get("12345678-1234-4234-8234-123456789012")).status).toBe("paused");}));
