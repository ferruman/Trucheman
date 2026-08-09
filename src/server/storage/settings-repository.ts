import { atomicJson } from "./atomic-file.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
const profileSchema=z.object({endpoint:z.string().url(),model:z.string().trim().min(1).max(200),hasApiKey:z.boolean()}).strict();
export const settingsSchema=z.object({translation:profileSchema,editing:profileSchema,pricing:z.object({input:z.number().finite().nonnegative(),output:z.number().finite().nonnegative()}).strict().optional()}).strict();
export type Settings=z.infer<typeof settingsSchema>;
const defaults:Settings={translation:{endpoint:"https://api.deepseek.com/chat/completions",model:"deepseek-v4-flash",hasApiKey:false},editing:{endpoint:"https://api.deepseek.com/chat/completions",model:"deepseek-v4-flash",hasApiKey:false}};
export class SettingsRepository{constructor(private path:string,private credentials:{translation?:boolean;editing?:boolean}={}){}async get():Promise<Settings>{let settings:Settings;try{const stored=JSON.parse(await readFile(this.path,"utf8")) as Partial<Settings>;settings=settingsSchema.parse({...defaults,...stored,translation:{...defaults.translation,...stored.translation},editing:{...defaults.editing,...stored.editing}});}catch{settings=structuredClone(defaults);}return {...settings,translation:{...settings.translation,hasApiKey:this.credentials.translation??settings.translation.hasApiKey},editing:{...settings.editing,hasApiKey:this.credentials.editing??settings.editing.hasApiKey}};}async save(settings:Settings){await atomicJson(this.path,settingsSchema.parse(settings));}}
