import { atomicJson } from "./atomic-file.js";
import { readFile } from "node:fs/promises";
export type Settings={translation:{endpoint:string;model:string;hasApiKey:boolean};editing:{endpoint:string;model:string;hasApiKey:boolean};pricing?:{input:number;output:number}};
const defaults:Settings={translation:{endpoint:"https://api.deepseek.com/chat/completions",model:"deepseek-chat",hasApiKey:false},editing:{endpoint:"https://api.deepseek.com/chat/completions",model:"deepseek-chat",hasApiKey:false}};
export class SettingsRepository{constructor(private path:string){}async get():Promise<Settings>{try{return {...defaults,...JSON.parse(await readFile(this.path,"utf8"))};}catch{return defaults;}}async save(settings:Settings){await atomicJson(this.path,settings);}}
