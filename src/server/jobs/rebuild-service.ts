import { rename } from "node:fs/promises";
import { buildEpub } from "../epub/build.js";
import { validateEpub } from "../epub/validate.js";
export async function rebuildOutput(stagingRoot:string,outputPath:string){const temporary=`${outputPath}.next`;await buildEpub(stagingRoot,temporary);const report=await validateEpub(stagingRoot);if(!report.ok)throw new Error(`Built EPUB failed validation: ${report.errors.join(", ")}`);await rename(temporary,outputPath);return report;}
