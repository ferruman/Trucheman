import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  summarizeLiteraryReview,
  type LiteraryComparisonReport,
  type LiteraryReviewExport,
} from "./literary-review.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const reportValue = argument("--report");
const reviewValue = argument("--review");
if (!reportValue || !reviewValue) {
  throw new Error("--report and --review are required");
}
const report = JSON.parse(await readFile(resolve(reportValue), "utf8")) as LiteraryComparisonReport;
const review = JSON.parse(await readFile(resolve(reviewValue), "utf8")) as LiteraryReviewExport;
const summary = summarizeLiteraryReview(report, review);
const text = `${JSON.stringify(summary, null, 2)}\n`;
const output = argument("--output");
if (output) {
  await writeFile(resolve(output), text);
  process.stdout.write(`Review summary: ${resolve(output)}\n`);
} else {
  process.stdout.write(text);
}
