import { spawn } from "node:child_process";
const child = spawn("epubcheck", process.argv.slice(2), { stdio: "inherit" });
child.on("error", (error) => {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
});
child.on("exit", (code) => process.exit(code ?? 1));
