import { readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parseContainer, parsePackage } from "../epub/package-parser.js";
import { resolveEpubPath } from "../epub/validate.js";
import { parseXml, serializeXml } from "../epub/xml-dom.js";
import { agreementFixes, type AgreementFix } from "../epub/morphology.js";

/**
 * Russian agreement corrections for a finished job, listed for a human and applied only by
 * number. There is deliberately no "apply everything": measured over two books, three of ten
 * proposals were right and the rest would have edited correct prose — «полным крови» into
 * «полной крови», an indeclinable «дзадзики» into agreement with a gender it does not have.
 *
 * The dictionary is good at spotting a mismatch and bad at knowing which of the two words is
 * wrong, so the choice stays with the reader. Applied text lands in `staging/`; rebuild the
 * job afterwards to get it into `output.epub`.
 */
type Located = AgreementFix & { path: string; context: string };

function textNodes(node: any, found: any[] = []): any[] {
  if (node.nodeType === 3) found.push(node);
  for (let child = node.firstChild; child; child = child.nextSibling) textNodes(child, found);
  return found;
}

async function stagingDocuments(staging: string) {
  const packagePath = parseContainer(
    await readFile(join(staging, "META-INF/container.xml"), "utf8"),
  );
  const packageFile = resolveEpubPath(staging, packagePath);
  const pkg = parsePackage(await readFile(packageFile, "utf8"), packagePath);
  const documents: string[] = [];
  for (const item of pkg.manifest.values()) {
    if (!/xhtml|html/i.test(item.mediaType)) continue;
    documents.push(resolveEpubPath(staging, item.href, posix.dirname(packagePath)));
  }
  return documents;
}

function context(text: string, phrase: string) {
  const at = text.indexOf(phrase);
  if (at < 0) return "";
  return `…${text.slice(Math.max(0, at - 60), at + phrase.length + 60).replace(/\s+/gu, " ")}…`;
}

async function main() {
  const [root, ...rest] = process.argv.slice(2);
  if (!root) throw new Error("usage: npm run fix:agreement -- data/jobs/<id> [--apply 1,3]");
  const selection = rest.includes("--apply")
    ? new Set(
        (rest[rest.indexOf("--apply") + 1] ?? "")
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value > 0),
      )
    : undefined;
  if (selection && !selection.size) throw new Error("--apply needs numbers, e.g. --apply 1,3");

  const paths = await stagingDocuments(join(root, "staging"));
  const found: Located[] = [];
  for (const path of paths) {
    const text = (parseXml(await readFile(path)).documentElement?.textContent ?? "").replace(
      /\s+/gu,
      " ",
    );
    for (const fix of await agreementFixes(text))
      found.push({ ...fix, path, context: context(text, fix.phrase) });
  }
  if (!found.length) {
    console.log("Nothing to correct (or `az` is not installed).");
    return;
  }
  found.forEach((fix, index) => {
    console.log(`${index + 1}. «${fix.phrase}» → «${fix.replacement}»   [${fix.kind}]`);
    if (fix.context) console.log(`   ${fix.context}`);
  });
  if (!selection) {
    console.log(`\nApply with: npm run fix:agreement -- ${root} --apply 1,2`);
    console.log("Read each one first: the dictionary sees a mismatch, not which word is wrong.");
    return;
  }
  let applied = 0;
  for (const [index, fix] of found.entries()) {
    if (!selection.has(index + 1)) continue;
    const dom = parseXml(await readFile(fix.path));
    // A phrase split across two text nodes is left alone: replacing half of it in one of them
    // is how a "fix" turns into a corrupted sentence.
    const node = textNodes(dom.documentElement).find(
      (candidate) => (candidate.nodeValue ?? "").split(fix.phrase).length === 2,
    );
    if (!node) {
      console.error(`! ${index + 1}: «${fix.phrase}» is not inside one text node, skipped`);
      continue;
    }
    node.nodeValue = (node.nodeValue as string).replace(fix.phrase, fix.replacement);
    await writeFile(fix.path, serializeXml(dom));
    applied++;
  }
  console.log(`\nApplied ${applied} correction(s) to staging.`);
  console.log("Rebuild the job to get them into output.epub: POST /api/jobs/<id>/rebuild");
}

await main();
