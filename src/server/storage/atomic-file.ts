import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function syncParentDirectory(path:string):Promise<void>{
  const handle=await open(dirname(path),"r");
  try{await handle.sync();}finally{await handle.close();}
}

export async function atomicWrite(path:string,content:string|Uint8Array):Promise<void>{
  await mkdir(dirname(path),{recursive:true});
  const tmp=`${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try{
    handle=await open(tmp,"wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle=undefined;
    await rename(tmp,path);
    await syncParentDirectory(path);
  }catch(error){
    await handle?.close().catch(()=>undefined);
    await rm(tmp,{force:true}).catch(()=>undefined);
    throw error;
  }
}
export async function atomicJson<T>(path:string,value:T):Promise<void> { await atomicWrite(path,JSON.stringify(value,null,2)+"\n"); }
