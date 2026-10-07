import { mkdir } from "node:fs/promises";
import { parseConfig } from "./config/schema.js";
import { createApp } from "./app.js";
import { recoverActiveJobs } from "./jobs/recovery.js";
const config = parseConfig();
await mkdir(config.dataDir, { recursive: true });
const loopbackOnly = /^(127\.0\.0\.1|localhost|::1)$/i.test(config.host);
const { app, jobs } = createApp(config.dataDir, {
  maxUploadBytes: config.maxUploadBytes,
  loopbackOnly,
});
await recoverActiveJobs(jobs);
app.listen(config.port, config.host, () =>
  console.log(`Trucheman listening on http://${config.host}:${config.port}`),
);
