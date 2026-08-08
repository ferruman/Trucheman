import type { ValidationReport } from "./validate.js";
export function publicValidationReport(report:ValidationReport){return {ok:report.ok,errors:report.errors,warnings:report.warnings,documents:report.documents};}
