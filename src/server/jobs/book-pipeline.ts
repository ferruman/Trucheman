import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractEpub } from "../epub/extract.js";
import { parseContainer, parsePackage } from "../epub/package-parser.js";
import { makeBatches, type Batch } from "../epub/batcher.js";
import { extractTextSegments, reinsertText, type TextSegment } from "../epub/text-segments.js";
import { parseXml, serializeXml } from "../epub/xml-dom.js";
import { buildEpub } from "../epub/build.js";
import { resolveEpubPath, validateEpubArchive } from "../epub/validate.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { loadSecrets } from "../config/secrets.js";
import { runTwoPass } from "./job-runner.js";
import type { PersistedJob } from "../domain/job.js";
import { syncParentDirectory } from "../storage/atomic-file.js";

export type PreparedDocument = { id:string; path:string; title:string; segments:TextSegment[]; batches:Batch[] };
export type PreparedBook = { staging:string; documents:PreparedDocument[] };

export function buildJobInstructions(job:Pick<PersistedJob,"sourceLanguage"|"targetLanguage"|"instructions">):string{
  return [`Translate from ${job.sourceLanguage} to ${job.targetLanguage}.`,job.instructions.trim()].filter(Boolean).join("\n");
}

export async function prepareBook(root:string):Promise<PreparedBook>{
  const staging=join(root,"staging");
  await rm(staging,{recursive:true,force:true});
  await mkdir(staging,{recursive:true});
  await extractEpub(join(root,"source.epub"),staging);
  const packagePath=parseContainer(await readFile(join(staging,"META-INF/container.xml"),"utf8"));
  const packageFile=resolveEpubPath(staging,packagePath);
  const bookPackage=parsePackage(await readFile(packageFile,"utf8"),packagePath);
  const documents:PreparedDocument[]=[];
  for(const [index,id] of bookPackage.spine.entries()){
    const item=bookPackage.manifest.get(id);
    if(!item||!/(xhtml|html)/i.test(item.mediaType))continue;
    const path=resolveEpubPath(staging,item.href,posix.dirname(packagePath));
    const documentId=`document-${index+1}`;
    const segments=extractTextSegments(parseXml(await readFile(path)),documentId);
    documents.push({id:documentId,path,title:id,segments,batches:makeBatches(segments)});
  }
  if(!documents.length)throw new Error("The EPUB has no eligible reading-order content documents");
  const prepared={staging,documents};
  await writeFile(join(root,"prepared.json"),JSON.stringify(prepared));
  return prepared;
}

export async function runPreparedBook(root:string,job:PersistedJob,update:(patch:Partial<PersistedJob>)=>Promise<void>,signal?:AbortSignal){
  // Assembly mutates staging documents. Re-extract the source on every run so a
  // retry can safely reuse completed model checkpoints without reinserting into
  // the output of an earlier run.
  const prepared=await prepareBook(root);
  const batches=prepared.documents.flatMap(document=>document.batches);
  const secrets=loadSecrets();
  const useExternal=process.env.BOOK_TRANSLATOR_PROVIDER!=="deterministic"&&Boolean(secrets.translationApiKey&&secrets.editingApiKey);
  const provider=useExternal?new DeepSeekProvider():new FakeProvider();
  const translationProfile={name:useExternal?"deepseek-translation":"deterministic-local",endpoint:secrets.translationEndpoint??process.env.BOOK_TRANSLATOR_TRANSLATION_ENDPOINT??"https://api.deepseek.com/chat/completions",model:secrets.translationModel??process.env.BOOK_TRANSLATOR_TRANSLATION_MODEL??"deepseek-chat",apiKey:secrets.translationApiKey};
  const editingProfile={name:useExternal?"deepseek-editing":"deterministic-local",endpoint:secrets.editingEndpoint??process.env.BOOK_TRANSLATOR_EDITING_ENDPOINT??"https://api.deepseek.com/chat/completions",model:secrets.editingModel??process.env.BOOK_TRANSLATOR_EDITING_MODEL??"deepseek-chat",apiKey:secrets.editingApiKey};
  const instructions=buildJobInstructions(job);
  let translated=0,edited=0;
  const result=await runTwoPass(batches,provider,{root,translationProfile,editingProfile,instructions,glossary:job.glossary,signal,onProgress:async(stage)=>{
    if(stage==="translation")translated++; else edited++;
    await update({stage,status:"running",progress:{...job.progress,translated,edited,total:batches.length}});
  }});
  for(const document of prepared.documents){
    const values=new Map<string,string>();
    for(const batch of document.batches)for(const segment of result.edits.get(batch.id)??[])values.set(segment.id,segment.text);
    const path=document.path,dom=parseXml(await readFile(path));
    reinsertText(dom,document.segments,values);
    await writeFile(path,serializeXml(dom));
  }
  await update({stage:"building",status:"running"});
  const output=join(root,"output.epub"),temporary=`${output}.${process.pid}.${randomUUID()}.tmp`;
  try{
    await buildEpub(prepared.staging,temporary);
    const handle=await open(temporary,"r");
    try{await handle.sync();}finally{await handle.close();}
    const report=await validateEpubArchive(temporary);
    if(!report.ok)throw new Error(`Output validation failed: ${report.errors.join(", ")}`);
    await rename(temporary,output);
    await syncParentDirectory(output);
    return report;
  }finally{
    await rm(temporary,{force:true});
  }
}
