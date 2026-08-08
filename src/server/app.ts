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
export function createApp(dataDir:string){const app=express();const jobs=new JobRepository(dataDir),settings=new SettingsRepository(join(dataDir,"settings.json")),events=new EventRepository(join(dataDir,"events.ndjson"));app.disable("x-powered-by");app.use(express.json({limit:"1mb"}));app.use("/api/jobs",jobsRouter(jobs));app.use("/api/settings",settingsRouter(settings));app.use("/api/jobs",jobEventsRouter(events));app.use("/api/jobs",jobControlRouter());app.use("/api/jobs",jobRetryRouter());app.use("/api/jobs",jobResultsRouter());app.get("/api/health",(_q,res)=>res.json({ok:true}));const client=join(process.cwd(),"dist/client");app.use(express.static(client));app.use((_q,res)=>res.sendFile(join(client,"index.html")));return {app,jobs,settings,events};}
