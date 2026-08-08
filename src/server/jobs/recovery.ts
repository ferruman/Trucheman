import type { JobRepository } from "../storage/job-repository.js";
export async function recoverActiveJobs(repo:JobRepository){for(const job of await repo.list()){if(job.status==="running"||job.status==="stopping"||job.status==="analyzing"){await repo.save({...job,status:"paused",updatedAt:new Date().toISOString()});}}}
