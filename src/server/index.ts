import { mkdir } from "node:fs/promises";
import { parseConfig } from "./config/schema.js";
import { createApp } from "./app.js";
import { recoverActiveJobs } from "./jobs/recovery.js";
const config=parseConfig();await mkdir(config.dataDir,{recursive:true});const {app,jobs}=createApp(config.dataDir,{maxUploadBytes:config.maxUploadBytes});await recoverActiveJobs(jobs);app.listen(config.port,config.host,()=>console.log(`Book Translator listening on http://${config.host}:${config.port}`));
