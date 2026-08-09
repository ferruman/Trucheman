import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildLiteraryReviewHtml, type LiteraryComparisonReport } from "./literary-review.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const reportValue = argument("--report");
if (!reportValue) throw new Error("--report is required");
const reportPath = resolve(reportValue);
const outputPath = resolve(argument("--output") ?? reportPath.replace(/\.json$/u, ".review.html"));
const report = JSON.parse(await readFile(reportPath, "utf8")) as LiteraryComparisonReport;
await writeFile(outputPath, buildLiteraryReviewHtml(report));
process.stdout.write(`Blind review: ${outputPath}\n`);
