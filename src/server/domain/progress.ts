import { progressFor, type Progress } from "../../shared/domain/job.js";
export function deriveProgress(total:number,drafts:Set<string>,edits:Set<string>,failed=0):Progress { return progressFor(drafts.size,edits.size,total,failed); }
