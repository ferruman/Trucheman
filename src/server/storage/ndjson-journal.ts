import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
export async function appendJournal(path:string, value:unknown):Promise<void> { await mkdir(dirname(path),{recursive:true}); const h=await open(path,"a"); try { await h.writeFile(JSON.stringify(value)+"\n"); await h.sync(); } finally { await h.close(); } }
export async function readJournal<T>(path:string):Promise<T[]> { let text=""; try { text=await readFile(path,"utf8"); } catch { return []; } const lines=text.split("\n").filter(Boolean); const out:T[]=[]; for(const line of lines) { try { out.push(JSON.parse(line) as T); } catch { break; } } return out; }
