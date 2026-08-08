import { useEffect, useState } from "react";
import type { JobView } from "../../../shared/domain/job";
import { api } from "../../app/api";
export function JobPage({id}:{id:string}){const [job,setJob]=useState<JobView>();useEffect(()=>{api.get(id).then(setJob);},[id]);return <section><h2>{job?.title??"Loading"}</h2>{job&&<p>Status: {job.status}. Progress: {job.progress.edited}/{job.progress.total} edited.</p>}</section>;}
