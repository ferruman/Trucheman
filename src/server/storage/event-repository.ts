import { appendJournal, readJournal } from "./ndjson-journal.js";
export type StoredEvent={id:number;type:string;timestamp:string;message:string;data?:Record<string,unknown>};
export class EventRepository{constructor(private path:string){}async append(event:Omit<StoredEvent,"id">){const current=await this.list();const next={...event,id:(current.at(-1)?.id??0)+1};await appendJournal(this.path,next);return next;}async list(after=0){return (await readJournal<StoredEvent>(this.path)).filter(x=>x.id>after);}}
