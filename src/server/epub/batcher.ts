import type { TextSegment } from "./text-segments.js";
export type Batch={id:string;documentId:string;segments:TextSegment[]};
export function estimateTokens(text:string):number{return Math.ceil(text.length/3.5);}
export function makeBatches(segments:TextSegment[],maxChars=12000):Batch[]{
  const out:Batch[]=[];
  let current:TextSegment[]=[],chars=0;
  const push=(documentId:string,values:TextSegment[])=>out.push({id:`${documentId}-batch-${out.length+1}`,documentId,segments:values});
  for(const segment of segments){
    if(current.length&&chars+segment.text.length>maxChars){const documentId=current[0].id.split(":")[0];push(documentId,current);current=[];chars=0;}
    if(segment.text.length>maxChars){
      const documentId=segment.id.split(":")[0],words=segment.text.split(/(?<=[.!?])\s+/);let chunk="";
      for(const word of words){if(chunk&&chunk.length+word.length+1>maxChars){push(documentId,[{...segment,text:chunk}]);chunk="";}chunk+=`${chunk?" ":""}${word}`;}
      if(chunk)push(documentId,[{...segment,text:chunk}]);
      continue;
    }
    current.push(segment);chars+=segment.text.length;
  }
  if(current.length){const documentId=current[0].id.split(":")[0];push(documentId,current);}
  return out;
}
