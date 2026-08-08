import { mkdir, rename, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export async function atomicWrite(path:string, content:string|Uint8Array):Promise<void> { await mkdir(dirname(path),{recursive:true}); const tmp=`${path}.${process.pid}.${Date.now()}.tmp`; const h=await open(tmp,"w"); try { await h.writeFile(content); await h.sync(); } finally { await h.close(); } await rename(tmp,path); }
export async function atomicJson<T>(path:string,value:T):Promise<void> { await atomicWrite(path,JSON.stringify(value,null,2)+"\n"); }
