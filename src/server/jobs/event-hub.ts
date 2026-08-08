import type { StoredEvent } from "../storage/event-repository.js";
export class EventHub{private listeners=new Set<(event:StoredEvent)=>void>();subscribe(listener:(event:StoredEvent)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}publish(event:StoredEvent){for(const listener of this.listeners)listener(event);}}
