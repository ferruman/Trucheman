export type RuntimeDefaults = {
  host: string;
  port: number;
  dataDir: string;
  maxUploadBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  requestTimeoutMs: number;
  maxRetries: number;
  batchChars: number;
};
export const defaults: RuntimeDefaults = Object.freeze({
  host: "127.0.0.1",
  port: 4173,
  dataDir: "./data",
  maxUploadBytes: 100 * 1024 * 1024,
  maxEntries: 10000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  requestTimeoutMs: 60000,
  maxRetries: 3,
  batchChars: 12000,
});
