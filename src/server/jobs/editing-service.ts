import type { LanguageModelProvider, ProviderProfile, ProviderSegment } from "../providers/provider.js";
import { processBatch } from "./translation-service.js";
export async function editBatch(provider:LanguageModelProvider,profile:ProviderProfile,original:ProviderSegment[],draft:ProviderSegment[],instructions="",glossary:unknown[]=[],signal?:AbortSignal){const segments=original.map((item,index)=>({id:item.id,text:`Original: ${item.text}\nDraft: ${draft[index]?.text??""}`}));return processBatch(provider,profile,"editing",segments,instructions,glossary,3,signal);}
