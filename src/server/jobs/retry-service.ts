export type RetryScope={batchId:string;chapterId?:string};
export function selectRetryScope(failed:RetryScope[],chapterId?:string):RetryScope[]{return chapterId?failed.filter(x=>x.chapterId===chapterId):failed.slice(0,1);}
