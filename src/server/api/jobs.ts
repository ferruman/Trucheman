import { Router } from "express";
import { createReadStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertLanguagePair } from "../../shared/languages.js";
import { newJobId, jobRoot } from "../storage/job-paths.js";
import { type JobRepository } from "../storage/job-repository.js";
import { type PersistedJob, toJobView } from "../domain/job.js";
import { problemResponse } from "./problem.js";
import { DomainError } from "../domain/errors.js";
import { prepareBook, runPreparedBook } from "../jobs/book-pipeline.js";

async function analyzeJob(repo:JobRepository,id:string){
  const job=await repo.get(id),root=jobRoot(repo.dataDir,id);
  await repo.save({...job,status:"analyzing",stage:"analysis",updatedAt:new Date().toISOString()});
  try{
    const prepared=await prepareBook(root),total=prepared.documents.reduce((sum,document)=>sum+document.batches.length,0);
    const next:PersistedJob={...job,status:"ready",stage:"analysis",progress:{translated:0,edited:0,total,failed:0},documents:prepared.documents.map(document=>({id:document.id,path:document.id,title:document.title,total:document.batches.length,translated:0,edited:0,status:"ready"})),updatedAt:new Date().toISOString()};
    await repo.save(next);return next;
  }catch(error){await repo.save({...job,status:"failed",stage:"analysis",updatedAt:new Date().toISOString()});throw error;}
}

export function jobsRouter(repo:JobRepository){
  const router=Router();
  router.get("/",async(_req,res)=>res.json((await repo.list()).map(toJobView)));
  router.post("/",async(req,res)=>{try{
    const {title="Untitled book",sourceLanguage="en",targetLanguage}=req.body as Record<string,string>;
    if(!targetLanguage)throw new Error("targetLanguage is required");
    assertLanguagePair(sourceLanguage as any,targetLanguage as any);
    const id=newJobId(),now=new Date().toISOString();
    const job:PersistedJob={version:1,id,title,sourceLanguage,targetLanguage,status:"created",stage:"import",progress:{translated:0,edited:0,total:0,failed:0},createdAt:now,updatedAt:now,warnings:0,documents:[],instructions:"",glossary:[]};
    await repo.save(job);res.status(201).json(toJobView(job));
  }catch(error){problemResponse(res,error,req);}});
  router.get("/:id",async(req,res)=>{try{res.json(toJobView(await repo.get(req.params.id)));}catch(error){problemResponse(res,error,req);}});
  router.put("/:id/config",async(req,res)=>{try{
    const job=await repo.get(req.params.id),body=req.body as Partial<PersistedJob>;
    const next:PersistedJob={...job,sourceLanguage:body.sourceLanguage??job.sourceLanguage,targetLanguage:body.targetLanguage??job.targetLanguage,instructions:body.instructions??job.instructions,glossary:body.glossary??job.glossary,updatedAt:new Date().toISOString()};
    assertLanguagePair(next.sourceLanguage as any,next.targetLanguage as any);await repo.save(next);res.json(toJobView(next));
  }catch(error){problemResponse(res,error,req);}});
  router.put("/:id/source",async(req,res)=>{try{
    const job=await repo.get(req.params.id),root=jobRoot(repo.dataDir,job.id);await mkdir(root,{recursive:true});
    if(!Buffer.isBuffer(req.body)||req.body.length===0)throw new DomainError("upload_missing","An EPUB upload is required",400);
    await BunlessWrite(root,req.body);res.status(204).end();
  }catch(error){console.error("EPUB upload failed",error instanceof Error?error.message:"unknown error");problemResponse(res,error,req);}});
  router.post("/:id/analyze",async(req,res)=>{try{res.status(202).json(toJobView(await analyzeJob(repo,req.params.id)));}catch(error){problemResponse(res,error,req);}});
  router.post("/:id/names/analyze",async(req,res)=>{try{res.status(202).json(toJobView(await analyzeJob(repo,req.params.id)));}catch(error){problemResponse(res,error,req);}});
  router.post("/:id/start",async(req,res)=>{try{
    const job=await repo.get(req.params.id);if(job.status!=="ready")throw new Error("Analyze the uploaded EPUB before starting");
    const root=jobRoot(repo.dataDir,job.id),running:PersistedJob={...job,status:"running",stage:"translation",updatedAt:new Date().toISOString()};await repo.save(running);res.status(202).json(toJobView(running));
    void runPreparedBook(root,running,async patch=>{const current=await repo.get(job.id);await repo.save({...current,...patch,updatedAt:new Date().toISOString()});}).then(async()=>{const current=await repo.get(job.id);await repo.save({...current,status:"completed",stage:"complete",updatedAt:new Date().toISOString()});}).catch(async error=>{const current=await repo.get(job.id);await repo.save({...current,status:"failed",stage:"validation",updatedAt:new Date().toISOString(),warnings:current.warnings+1});console.error(error);});
  }catch(error){problemResponse(res,error,req);}});
  router.get("/:id/download",async(req,res)=>{try{const path=join(jobRoot(repo.dataDir,req.params.id),"output.epub");await access(path);res.type("application/epub+zip");createReadStream(path).on("error",error=>problemResponse(res,error,req)).pipe(res);}catch(error){problemResponse(res,error,req);}});
  router.delete("/:id",async(req,res)=>{try{await repo.remove(req.params.id);res.status(204).end();}catch(error){problemResponse(res,error,req);}});
  return router;
}

async function BunlessWrite(root:string,body:Buffer){const {writeFile}=await import("node:fs/promises");await writeFile(join(root,"source.epub"),body);}
