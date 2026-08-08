import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { jobRoot, child } from "./job-paths.js";
import { atomicJson } from "./atomic-file.js";
import { validateJob, type PersistedJob } from "../domain/job.js";
export class JobRepository { constructor(public readonly dataDir:string){}
  async save(job:PersistedJob){const valid=validateJob(job);const root=jobRoot(this.dataDir,valid.id);await mkdir(root,{recursive:true});await atomicJson(child(root,"state"),valid);}
  async get(id:string){const raw=JSON.parse(await readFile(child(jobRoot(this.dataDir,id),"state"),"utf8"));return validateJob(raw);}
  async list(){let entries:string[]=[];try{entries=await readdir(`${this.dataDir}/jobs`);}catch{return [];}const out:PersistedJob[]=[];for(const id of entries){try{out.push(await this.get(id));}catch{/* ignore incomplete/unrelated roots */}}return out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  async remove(id:string){await rm(jobRoot(this.dataDir,id),{recursive:true,force:true});}
}
