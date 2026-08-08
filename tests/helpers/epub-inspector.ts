import { readFile } from "node:fs/promises";
import { parseContainer, parsePackage } from "../../src/server/epub/package-parser.js";
export async function inspectEpub(root:string){const packagePath=parseContainer(await readFile(`${root}/META-INF/container.xml`,`utf8`)),pkg=parsePackage(await readFile(`${root}/${packagePath}`,`utf8`),packagePath);return {packagePath,spine:pkg.spine,manifest:[...pkg.manifest.keys()]};}
