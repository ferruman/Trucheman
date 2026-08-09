import { z } from "zod";
import type { LanguageModelProvider, ProviderProfile } from "./provider.js";
export const nameEntrySchema = z.object({
  source: z.string().min(1),
  target: z.string(),
  category: z.enum(["person", "place", "organization", "other"]),
  note: z.string().optional(),
  aliasOf: z.string().optional(),
});
export type NameEntry = z.infer<typeof nameEntrySchema> & { id: string; enabled: boolean };
export function canonicalizeNames(entries: NameEntry[]): NameEntry[] {
  const bySource = new Map<string, NameEntry>();
  for (const entry of entries) {
    const key = entry.source.trim().toLocaleLowerCase();
    if (!bySource.has(key)) bySource.set(key, { ...entry, source: entry.source.trim() });
  }
  return [...bySource.values()];
}
export function relevantGlossary(entries: NameEntry[], text: string) {
  const lower = text.toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      entry.enabled && (lower.includes(entry.source.toLocaleLowerCase()) || !entry.aliasOf),
  );
}
export async function analyzeNames(
  provider: LanguageModelProvider,
  profile: ProviderProfile,
  text: string,
) {
  const unspecified = { tag: "und", name: "Unspecified" };
  const result = await provider.complete({
    profile,
    mode: "translation",
    sourceLanguage: unspecified,
    targetLanguage: unspecified,
    segments: [
      {
        id: "names",
        text: `Extract proper names from this text and return an empty translation if none are present.\n${text}`,
      },
    ],
  });
  try {
    return canonicalizeNames(
      JSON.parse(result.segments[0]?.text ?? "[]").map((item: any, index: number) => ({
        ...nameEntrySchema.parse(item),
        id: `name-${index}`,
        enabled: true,
      })),
    );
  } catch {
    return [];
  }
}
