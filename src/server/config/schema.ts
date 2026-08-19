import { z } from "zod";
import { defaults } from "./defaults.js";
const envSchema = z.object({
  TRUCHEMAN_HOST: z.string().min(1).default(defaults.host),
  TRUCHEMAN_PORT: z.coerce.number().int().min(1).max(65535).default(defaults.port),
  TRUCHEMAN_DATA_DIR: z.string().min(1).default(defaults.dataDir),
  TRUCHEMAN_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(defaults.maxUploadBytes),
});
export type RuntimeConfig = Readonly<
  typeof defaults & { host: string; port: number; dataDir: string; maxUploadBytes: number }
>;
export function parseConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const p = envSchema.parse({
    TRUCHEMAN_HOST: env.TRUCHEMAN_HOST ?? env.BOOK_TRANSLATOR_HOST,
    TRUCHEMAN_PORT: env.TRUCHEMAN_PORT ?? env.BOOK_TRANSLATOR_PORT,
    TRUCHEMAN_DATA_DIR: env.TRUCHEMAN_DATA_DIR ?? env.BOOK_TRANSLATOR_DATA_DIR,
    TRUCHEMAN_MAX_UPLOAD_BYTES:
      env.TRUCHEMAN_MAX_UPLOAD_BYTES ?? env.BOOK_TRANSLATOR_MAX_UPLOAD_BYTES,
  });
  return Object.freeze({
    ...defaults,
    host: p.TRUCHEMAN_HOST,
    port: p.TRUCHEMAN_PORT,
    dataDir: p.TRUCHEMAN_DATA_DIR,
    maxUploadBytes: p.TRUCHEMAN_MAX_UPLOAD_BYTES,
  });
}
