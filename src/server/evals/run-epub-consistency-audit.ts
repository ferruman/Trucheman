import { auditEpubArchive } from "../epub/consistency-audit.js";

const archivePath = process.argv[2];
const expectedLanguage = process.argv[3] ?? "ru";
if (!archivePath) {
  console.error("Usage: npm run audit:epub -- <book.epub> [language]");
  process.exitCode = 2;
} else {
  const report = await auditEpubArchive(archivePath, expectedLanguage);
  console.log(JSON.stringify(report, null, 2));
  if (report.warnings.length) process.exitCode = 1;
}
