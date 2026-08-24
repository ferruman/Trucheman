import type { TextSegment } from "./text-segments.js";
import { sourceLanguageCapabilities } from "../languages/registry.js";
export type Batch = { id: string; documentId: string; segments: TextSegment[] };

export const MAX_BATCH_SEGMENTS = 20;
export const MAX_BATCH_CHARS = 12000;

/**
 * The budget is in characters, but what it is really rationing is context. A Japanese
 * character carries roughly what three English ones do and costs about one token by itself,
 * so a batch measured in Latin characters asks for several times the intended window — and
 * the Russian it comes back as is longer again than the source.
 */
export function batchCharBudget(sourceLanguage?: string): number {
  return sourceLanguageCapabilities(sourceLanguage).batchCharBudget ?? MAX_BATCH_CHARS;
}

/**
 * Which of the two limits actually binds depends on the language, and for Japanese it is this
 * one: short Japanese paragraphs can reach the segment cap long before the character budget.
 * Twenty Japanese paragraphs average
 * forty-odd characters each, and asking one answer to carry twenty fragments that short made
 * the model lose count. Ten is the conservative cap used up front.
 */
export function batchSegmentCap(sourceLanguage?: string): number {
  return sourceLanguageCapabilities(sourceLanguage).batchSegmentCap ?? MAX_BATCH_SEGMENTS;
}

/**
 * Sentence ends, for splitting a text node that overruns the budget on its own. Japanese
 * writes no space after 。, so requiring whitespace found no boundary at all and handed the
 * provider the whole oversized node; a closing 」 belongs to the sentence it ends.
 */
const sentenceEnd = /(?<=[.!?])\s+|(?<=[。！？])(?![」』）】\s])/u;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Japanese runs together; joining its chunks with a space invents word boundaries. */
function joiner(left: string, right: string) {
  if (!left) return "";
  return CJK.test(left.slice(-1)) || CJK.test(right.slice(0, 1)) ? "" : " ";
}

/**
 * A text node larger than the batch budget is split across batches. Chunks carry a
 * `<segment id>#<n>` suffix so they stay distinct all the way through the journals;
 * `mergeChunkedSegments` puts them back together before reinsertion. Reusing the bare
 * segment id here would make the pieces collide in the id-keyed reinsertion map and
 * silently drop everything but the last chunk.
 */
const chunkSuffix = /#\d+$/;

export function baseSegmentId(id: string): string {
  return id.replace(chunkSuffix, "");
}

export function mergeChunkedSegments<T extends { id: string; text: string }>(segments: T[]): T[] {
  const out: T[] = [];
  const positions = new Map<string, number>();
  for (const segment of segments) {
    const id = baseSegmentId(segment.id);
    const at = positions.get(id);
    if (at === undefined) {
      positions.set(id, out.length);
      out.push({ ...segment, id });
      continue;
    }
    const previous = out[at].text;
    const separator = !previous || /\s$/u.test(previous) || /^\s/u.test(segment.text) ? "" : " ";
    out[at] = { ...out[at], text: previous + separator + segment.text };
  }
  return out;
}

export function makeBatches(
  segments: TextSegment[],
  maxChars = MAX_BATCH_CHARS,
  maxSegments = MAX_BATCH_SEGMENTS,
): Batch[] {
  const out: Batch[] = [];
  let current: TextSegment[] = [];
  let chars = 0;
  const push = (documentId: string, values: TextSegment[]) =>
    out.push({
      id: `${documentId}-batch-${out.length + 1}`,
      documentId,
      segments: values,
    });
  const flush = () => {
    if (!current.length) return;
    push(current[0].id.split(":")[0], current);
    current = [];
    chars = 0;
  };

  for (const segment of segments) {
    if (
      current.length &&
      (chars + segment.text.length > maxChars || current.length >= maxSegments)
    ) {
      flush();
    }
    if (segment.text.length > maxChars) {
      const documentId = segment.id.split(":")[0];
      // Trailing whitespace yields an empty tail piece that would append a stray space.
      const sentences = segment.text.split(sentenceEnd).filter(Boolean);
      const chunks: string[] = [];
      let chunk = "";
      for (const sentence of sentences) {
        if (chunk && chunk.length + sentence.length + 1 > maxChars) {
          chunks.push(chunk);
          chunk = "";
        }
        chunk += `${joiner(chunk, sentence)}${sentence}`;
      }
      if (chunk) chunks.push(chunk);
      for (const [index, text] of chunks.entries()) {
        const id = chunks.length > 1 ? `${segment.id}#${index + 1}` : segment.id;
        push(documentId, [{ ...segment, id, text }]);
      }
      continue;
    }
    current.push(segment);
    chars += segment.text.length;
  }
  flush();
  return out;
}
