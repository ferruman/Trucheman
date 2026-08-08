export function subscribeToJobEvents(id:string,onEvent:(event:MessageEvent)=>void){const source=new EventSource(`/api/jobs/${id}/events`);source.onmessage=onEvent;return ()=>source.close();}
