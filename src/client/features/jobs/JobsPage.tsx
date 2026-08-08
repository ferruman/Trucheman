import { useEffect, useState } from "react";
import type { JobView } from "../../../shared/domain/job";
import { api } from "../../app/api";
export function JobsPage(){const [jobs,setJobs]=useState<JobView[]>([]);useEffect(()=>{api.list().then(setJobs).catch(()=>setJobs([]));},[]);return <section><h2>Jobs</h2>{jobs.length===0?<p>No books yet. <a href="/new">Create a job</a>.</p>:<ul>{jobs.map(j=><li key={j.id}><a href={`/jobs/${j.id}`}>{j.title}</a> — {j.sourceLanguage} → {j.targetLanguage} — {j.status}</li>)}</ul>}</section>;}
