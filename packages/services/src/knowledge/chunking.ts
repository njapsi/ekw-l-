/**
 * Part 15: intelligent chunking that preserves semantic boundaries
 * (heading/paragraph) rather than an arbitrary fixed-size cut wherever
 * possible. Markdown-aware: a `#`/`##`/… heading starts a new chunk and is
 * carried in its `heading` metadata; otherwise chunks are built paragraph by
 * paragraph up to `maxChars`, never splitting a paragraph in half unless a
 * single paragraph alone exceeds `maxChars` (rare; a hard cut then, better
 * than an unbounded chunk).
 */

export interface DocumentChunk {
  index: number;
  text: string;
  heading: string | null;
  paragraphIndex: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function chunkDocument(rawText: string, maxChars = 1500): DocumentChunk[] {
  const text = rawText.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: DocumentChunk[] = [];
  let currentHeading: string | null = null;
  let buffer: string[] = [];
  let bufferLen = 0;
  let paragraphIndex = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({
      index: chunks.length,
      text: buffer.join('\n\n'),
      heading: currentHeading,
      paragraphIndex,
    });
    buffer = [];
    bufferLen = 0;
  };

  for (const para of paragraphs) {
    const headingMatch = HEADING_RE.exec(para);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2]!.trim();
      paragraphIndex++;
      continue;
    }
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push({
          index: chunks.length,
          text: para.slice(i, i + maxChars),
          heading: currentHeading,
          paragraphIndex,
        });
      }
      paragraphIndex++;
      continue;
    }
    if (bufferLen + para.length > maxChars && buffer.length > 0) {
      flush();
    }
    buffer.push(para);
    bufferLen += para.length;
    paragraphIndex++;
  }
  flush();
  return chunks;
}
