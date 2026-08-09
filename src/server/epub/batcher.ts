import type { TextSegment } from "./text-segments.js";
export type Batch = { id: string; documentId: string; segments: TextSegment[] };

export const MAX_BATCH_SEGMENTS = 20;

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
      // Trailing whitespace yields an empty tail piece that would append a stray space.
      const sentences = segment.text.split(/(?<=[.!?])\s+/).filter(Boolean);
      const chunks: string[] = [];
      let chunk = "";
      for (const sentence of sentences) {
        if (chunk && chunk.length + sentence.length + 1 > maxChars) {
          chunks.push(chunk);
          chunk = "";
        }
        chunk += `${chunk ? " " : ""}${sentence}`;
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
