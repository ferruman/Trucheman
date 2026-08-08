import { JobsPage } from "../features/jobs/JobsPage";
import { NewJobPage } from "../features/jobs/NewJobPage";
import { JobPage } from "../features/jobs/JobPage";
export function Routes(){const path=location.pathname;const match=path.match(/^\/jobs\/([^/]+)/);return path==="/new"?<NewJobPage/>:match?<JobPage id={match[1]}/>:<JobsPage/>;}
