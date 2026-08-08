import { appendJournal, readJournal } from "./ndjson-journal.js";
export type StoredEvent={id:number;jobId?:string;type:string;timestamp:string;message:string;data?:Record<string,unknown>};
export class EventRepository{
  private writes:Promise<unknown>=Promise.resolve();
  private listeners=new Set<(event:StoredEvent)=>void>();
  constructor(private path:string){}
  append(event:Omit<StoredEvent,"id">){const write=this.writes.then(async()=>{const current=await this.list();const next={...event,id:(current.at(-1)?.id??0)+1};await appendJournal(this.path,next);for(const listener of this.listeners){try{listener(next);}catch{/* disconnected consumers must not fail persisted work */}}return next;});this.writes=write.catch(()=>undefined);return write;}
  async list(after=0,jobId?:string){return (await readJournal<StoredEvent>(this.path)).filter(x=>x.id>after&&(!jobId||x.jobId===jobId));}
  subscribe(jobId:string,listener:(event:StoredEvent)=>void){const scoped=(event:StoredEvent)=>{if(event.jobId===jobId)listener(event);};this.listeners.add(scoped);return ()=>this.listeners.delete(scoped);}
}
