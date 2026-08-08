import express from "express";
import { join } from "node:path";
import { jobsRouter } from "./api/jobs.js";
import { settingsRouter } from "./api/settings.js";
import { JobRepository } from "./storage/job-repository.js";
import { SettingsRepository } from "./storage/settings-repository.js";
import { jobEventsRouter } from "./api/job-events.js";
import { jobControlRouter } from "./api/job-control.js";
import { jobRetryRouter } from "./api/job-retry.js";
import { jobResultsRouter } from "./api/job-results.js";
import { EventRepository } from "./storage/event-repository.js";
import { JobOrchestrator } from "./jobs/job-orchestrator.js";
import { defaults } from "./config/defaults.js";
import { loadSecrets } from "./config/secrets.js";

export function createApp(dataDir:string,options:{maxUploadBytes?:number}={}){
  const secrets=loadSecrets();
  const app=express(),jobs=new JobRepository(dataDir),settings=new SettingsRepository(join(dataDir,"settings.json"),{translation:Boolean(secrets.translationApiKey),editing:Boolean(secrets.editingApiKey)}),events=new EventRepository(join(dataDir,"events.ndjson"));
  const orchestrator=new JobOrchestrator(jobs,{onEvent:async(jobId,type,message,data)=>{await events.append({jobId,type,message,data,timestamp:new Date().toISOString()});}});
  app.disable("x-powered-by");
  app.use(express.raw({type:["application/epub+zip","application/octet-stream"],limit:options.maxUploadBytes??defaults.maxUploadBytes}));
  app.use(express.json({limit:"1mb"}));
  app.use("/api/jobs",jobsRouter(jobs,orchestrator));
  app.use("/api/settings",settingsRouter(settings));
  app.use("/api/jobs",jobEventsRouter(events));
  app.use("/api/jobs",jobControlRouter(jobs,orchestrator));
  app.use("/api/jobs",jobRetryRouter(jobs,orchestrator));
  app.use("/api/jobs",jobResultsRouter(jobs,orchestrator));
  app.get("/api/health",(_q,res)=>res.json({ok:true}));
  const client=join(process.cwd(),"dist/client");app.use(express.static(client));app.use((_q,res)=>res.sendFile(join(client,"index.html")));
  return {app,jobs,settings,events,orchestrator};
}
