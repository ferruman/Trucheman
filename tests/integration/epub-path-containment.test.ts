import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEpubPath } from "../../src/server/epub/validate.js";
import { prepareBook } from "../../src/server/jobs/book-pipeline.js";

const roots:string[]=[];

async function temporaryRoot():Promise<string>{
  const root=await mkdtemp(join(tmpdir(),"epub-containment-"));
  roots.push(root);
  return root;
}

async function writeEpub(path:string,files:Record<string,string>):Promise<void>{
  const zip=new yazl.ZipFile();
  zip.addBuffer(Buffer.from("application/epub+zip"),"mimetype",{compress:false});
  for(const [name,content] of Object.entries(files))zip.addBuffer(Buffer.from(content),name);
  await mkdir(join(path,".."),{recursive:true});
  await new Promise<void>((resolve,reject)=>{
    const stream=createWriteStream(path);
    stream.on("error",reject).on("close",resolve);
    zip.outputStream.pipe(stream);
    zip.end();
  });
}

afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe("EPUB path containment",()=>{
  it.each(["../../outside.xhtml","/etc/passwd","C:/secret.xhtml","https://example.test/book.xhtml","//server/share","chapter.xhtml#part","chapter.xhtml?raw=1","chapter%2fxhtml","chapter%5cxhtml","%2e%2e%2foutside.xhtml","chapter\\name.xhtml"])("rejects unsafe reference %s",async reference=>{
    const root=await temporaryRoot();
    expect(()=>resolveEpubPath(root,reference,"OEBPS")).toThrow();
  });

  it("resolves a percent-encoded file name inside staging",async()=>{
    const root=await temporaryRoot();
    expect(resolveEpubPath(root,"Text/chapter%201.xhtml","OEBPS")).toBe(join(root,"OEBPS/Text/chapter 1.xhtml"));
  });

  it("rejects a container package path that escapes staging",async()=>{
    const root=await temporaryRoot();
    const packageXml=`<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`;
    await writeFile(join(root,"outside.opf"),packageXml);
    await writeFile(join(root,"chapter.xhtml"),"<html><body>outside</body></html>");
    await writeEpub(join(root,"source.epub"),{"META-INF/container.xml":`<container><rootfiles><rootfile full-path="../outside.opf"/></rootfiles></container>`});
    await expect(prepareBook(root)).rejects.toThrow(/escapes|unsafe/i);
  });

  it("rejects a decoded manifest href that escapes staging",async()=>{
    const root=await temporaryRoot();
    const packageXml=`<package><manifest><item id="chapter" href="%2e%2e/%2e%2e/outside.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`;
    await writeFile(join(root,"outside.xhtml"),"<html><body>outside</body></html>");
    await writeEpub(join(root,"source.epub"),{
      "META-INF/container.xml":`<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      "OEBPS/content.opf":packageXml,
    });
    await expect(prepareBook(root)).rejects.toThrow(/escapes|unsafe/i);
  });
});
