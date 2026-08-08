import { z } from "zod";
import { defaults } from "./defaults.js";
const envSchema = z.object({ BOOK_TRANSLATOR_HOST:z.string().min(1).default(defaults.host), BOOK_TRANSLATOR_PORT:z.coerce.number().int().min(1).max(65535).default(defaults.port), BOOK_TRANSLATOR_DATA_DIR:z.string().min(1).default(defaults.dataDir), BOOK_TRANSLATOR_MAX_UPLOAD_BYTES:z.coerce.number().int().positive().default(defaults.maxUploadBytes) });
export type RuntimeConfig = Readonly<typeof defaults & { host:string; port:number; dataDir:string; maxUploadBytes:number }>;
export function parseConfig(env: Record<string,string|undefined> = process.env): RuntimeConfig { const p=envSchema.parse(env); return Object.freeze({...defaults,host:p.BOOK_TRANSLATOR_HOST,port:p.BOOK_TRANSLATOR_PORT,dataDir:p.BOOK_TRANSLATOR_DATA_DIR,maxUploadBytes:p.BOOK_TRANSLATOR_MAX_UPLOAD_BYTES}); }
