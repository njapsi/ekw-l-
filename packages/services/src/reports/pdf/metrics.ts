/**
 * Advance widths (per 1000 units) for the two standard PDF base-14 fonts we
 * use — Helvetica and Helvetica-Bold. Using base-14 fonts means no font file
 * has to be embedded. The tables cover printable ASCII 32–126; anything outside
 * that range is approximated by the width of "n". This gives accurate enough
 * line wrapping for a text report without a font-metrics dependency.
 */

// prettier-ignore
const HELVETICA: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// prettier-ignore
const HELVETICA_BOLD: number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

export type PdfFont = 'regular' | 'bold';

function widths(font: PdfFont): number[] {
  return font === 'bold' ? HELVETICA_BOLD : HELVETICA;
}

/** Width of a string in points at the given font size. */
export function measureText(text: string, fontSize: number, font: PdfFont = 'regular'): number {
  const table = widths(font);
  const fallback = table['n'.charCodeAt(0) - 32] ?? 556;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const w = code >= 32 && code <= 126 ? (table[code - 32] ?? fallback) : fallback;
    units += w;
  }
  return (units / 1000) * fontSize;
}

/**
 * Greedy word-wrap. Breaks on spaces; a single word longer than `maxWidth` is
 * hard-split so it never overflows the page.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  font: PdfFont = 'regular',
): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, fontSize, font) <= maxWidth || !line) {
        if (measureText(word, fontSize, font) > maxWidth && !line) {
          // hard-split an over-long word
          let chunk = '';
          for (const ch of word) {
            if (measureText(chunk + ch, fontSize, font) > maxWidth && chunk) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
