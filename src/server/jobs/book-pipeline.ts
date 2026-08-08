import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractEpub } from "../epub/extract.js";
import { parseContainer, parsePackage } from "../epub/package-parser.js";
import { makeBatches, type Batch } from "../epub/batcher.js";
import { extractTextSegments, reinsertText, type TextSegment } from "../epub/text-segments.js";
import { parseXml, serializeXml } from "../epub/xml-dom.js";
import { buildEpub } from "../epub/build.js";
import { validateEpub } from "../epub/validate.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { runTwoPass } from "./job-runner.js";
import type { PersistedJob } from "../domain/job.js";

export type PreparedDocument = { id:string; path:string; title:string; segments:TextSegment[]; batches:Batch[] };
export type PreparedBook = { staging:string; documents:PreparedDocument[] };

export async function prepareBook(root:string):Promise<PreparedBook>{
  const staging=join(root,"staging");
  await rm(staging,{recursive:true,force:true});
  await mkdir(staging,{recursive:true});
  await extractEpub(join(root,"source.epub"),staging);
  const packagePath=parseContainer(await readFile(join(staging,"META-INF/container.xml"),"utf8"));
  const bookPackage=parsePackage(await readFile(join(staging,packagePath),"utf8"),packagePath);
  const documents:PreparedDocument[]=[];
  for(const [index,id] of bookPackage.spine.entries()){
    const item=bookPackage.manifest.get(id);
    if(!item||!/(xhtml|html)/i.test(item.mediaType))continue;
    const relativePath=posix.normalize(posix.join(posix.dirname(packagePath),decodeURIComponent(item.href)));
    const path=join(staging,...relativePath.split("/"));
    const documentId=`document-${index+1}`;
    const segments=extractTextSegments(parseXml(await readFile(path)),documentId);
    documents.push({id:documentId,path,title:id,segments,batches:makeBatches(segments)});
  }
  if(!documents.length)throw new Error("The EPUB has no eligible reading-order content documents");
  const prepared={staging,documents};
  await writeFile(join(root,"prepared.json"),JSON.stringify(prepared));
  return prepared;
}

export async function runPreparedBook(root:string,job:PersistedJob,update:(patch:Partial<PersistedJob>)=>Promise<void>){
  const prepared=JSON.parse(await readFile(join(root,"prepared.json"),"utf8")) as PreparedBook;
  const batches=prepared.documents.flatMap(document=>document.batches);
  const profile={name:"deterministic-local",endpoint:"local",model:"deterministic"};
  let translated=0,edited=0;
  const result=await runTwoPass(batches,new FakeProvider(),{root,translationProfile:profile,editingProfile:profile,onProgress:async(stage)=>{
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
  const output=join(root,"output.epub"),temporary=join(root,"output.next.epub");
  await buildEpub(prepared.staging,temporary);
  const report=await validateEpub(prepared.staging);
  if(!report.ok)throw new Error(`Output validation failed: ${report.errors.join(", ")}`);
  await rm(output,{force:true});
  await writeFile(output,await readFile(temporary));
  await rm(temporary,{force:true});
  return report;
}
