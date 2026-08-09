import type { TextSegment } from "./text-segments.js";
export type Batch = { id: string; documentId: string; segments: TextSegment[] };

export const MAX_BATCH_SEGMENTS = 20;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function makeBatches(
  segments: TextSegment[],
  maxChars = 12000,
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
      const words = segment.text.split(/(?<=[.!?])\s+/);
      let chunk = "";
      for (const word of words) {
        if (chunk && chunk.length + word.length + 1 > maxChars) {
          push(documentId, [{ ...segment, text: chunk }]);
          chunk = "";
        }
        chunk += `${chunk ? " " : ""}${word}`;
      }
      if (chunk) push(documentId, [{ ...segment, text: chunk }]);
      continue;
    }
    current.push(segment);
    chars += segment.text.length;
  }
  flush();
  return out;
}
