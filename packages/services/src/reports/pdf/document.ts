/**
 * A deliberately small PDF writer — enough to lay out a text report
 * (headings, paragraphs, key/value rows, simple tables, page breaks, a footer)
 * with the base-14 Helvetica fonts, so no font file is embedded and no PDF
 * dependency is added (same "own the insulation layer" reasoning as the Stripe
 * gateway in ADR-0025). Output is deterministic: the same content always
 * produces the same bytes.
 *
 * Not a general PDF toolkit — no images, colours beyond greyscale, or vector
 * graphics. That is an accepted limitation for v1 (docs/REPORTING.md §7).
 */
import { type PdfFont, measureText, wrapText } from './metrics.js';

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const MARGIN_TOP = 60;
const MARGIN_BOTTOM = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

function escapePdfText(s: string): string {
  // Strip anything outside printable ASCII (base-14 WinAnsi safe subset) then
  // escape the three characters that are special inside a PDF string literal.
  return s
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

export interface PdfDocumentOptions {
  footerText?: string;
}

export class PdfDocument {
  private readonly pages: string[] = [];
  private current: string[] = [];
  private y = PAGE_HEIGHT - MARGIN_TOP;
  private pageNo = 0;
  private readonly footerText: string;

  constructor(opts: PdfDocumentOptions = {}) {
    this.footerText = opts.footerText ?? '';
    this.newPage();
  }

  private newPage(): void {
    if (this.pageNo > 0) this.pages.push(this.current.join('\n'));
    this.current = [];
    this.y = PAGE_HEIGHT - MARGIN_TOP;
    this.pageNo += 1;
    if (this.footerText) {
      const size = 8;
      const w = measureText(this.footerText, size, 'regular');
      this.text(this.footerText, (PAGE_WIDTH - w) / 2, MARGIN_BOTTOM - 24, size, 'regular');
    }
  }

  private ensureSpace(needed: number): void {
    if (this.y - needed < MARGIN_BOTTOM) this.newPage();
  }

  private text(value: string, x: number, y: number, size: number, font: PdfFont): void {
    const fontRef = font === 'bold' ? '/F2' : '/F1';
    this.current.push(
      `BT ${fontRef} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(
        value,
      )}) Tj ET`,
    );
  }

  private line(x1: number, y1: number, x2: number, y2: number, gray = 0.8): void {
    this.current.push(
      `q ${gray} G 0.75 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`,
    );
  }

  // --- public layout API -------------------------------------------------

  spacer(pts = 8): void {
    this.y -= pts;
  }

  title(text: string): void {
    this.ensureSpace(30);
    for (const ln of wrapText(text, CONTENT_WIDTH, 20, 'bold')) {
      this.ensureSpace(24);
      this.text(ln, MARGIN_X, this.y, 20, 'bold');
      this.y -= 24;
    }
    this.spacer(6);
  }

  heading(text: string): void {
    this.spacer(10);
    this.ensureSpace(22);
    this.text(text, MARGIN_X, this.y, 13, 'bold');
    this.y -= 16;
    this.line(MARGIN_X, this.y + 4, PAGE_WIDTH - MARGIN_X, this.y + 4);
    this.spacer(6);
  }

  paragraph(text: string, opts: { size?: number; font?: PdfFont; gap?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.font ?? 'regular';
    const leading = size * 1.35;
    for (const ln of wrapText(text, CONTENT_WIDTH, size, font)) {
      this.ensureSpace(leading);
      if (ln) this.text(ln, MARGIN_X, this.y, size, font);
      this.y -= leading;
    }
    this.spacer(opts.gap ?? 4);
  }

  bullet(text: string, opts: { indent?: number } = {}): void {
    const size = 10;
    const leading = size * 1.35;
    const indent = opts.indent ?? 14;
    const lines = wrapText(text, CONTENT_WIDTH - indent, size, 'regular');
    lines.forEach((ln, i) => {
      this.ensureSpace(leading);
      if (i === 0) this.text('-', MARGIN_X, this.y, size, 'regular');
      this.text(ln, MARGIN_X + indent, this.y, size, 'regular');
      this.y -= leading;
    });
  }

  keyValue(key: string, value: string): void {
    const size = 10;
    const leading = size * 1.4;
    const keyWidth = 170;
    const valueLines = wrapText(value, CONTENT_WIDTH - keyWidth, size, 'regular');
    this.ensureSpace(leading * Math.max(1, valueLines.length));
    this.text(key, MARGIN_X, this.y, size, 'bold');
    valueLines.forEach((ln, i) => {
      if (i > 0) this.ensureSpace(leading);
      this.text(ln, MARGIN_X + keyWidth, this.y, size, 'regular');
      this.y -= leading;
    });
  }

  table(headers: string[], rows: string[][]): void {
    if (headers.length === 0) return;
    const size = 9;
    const leading = size * 1.5;
    const colWidth = CONTENT_WIDTH / headers.length;

    const drawRow = (cells: string[], font: PdfFont): void => {
      const wrapped = cells.map((c) => wrapText(c ?? '', colWidth - 6, size, font));
      const rowHeight = leading * Math.max(1, ...wrapped.map((w) => w.length));
      this.ensureSpace(rowHeight + 2);
      const top = this.y;
      wrapped.forEach((linesForCell, col) => {
        linesForCell.forEach((ln, i) => {
          this.text(ln, MARGIN_X + col * colWidth + 2, top - i * leading, size, font);
        });
      });
      this.y = top - rowHeight;
      this.line(MARGIN_X, this.y + leading - 2, PAGE_WIDTH - MARGIN_X, this.y + leading - 2, 0.85);
    };

    drawRow(headers, 'bold');
    for (const row of rows) drawRow(row, 'regular');
    this.spacer(6);
  }

  // --- serialize -------------------------------------------------------

  toBytes(): Uint8Array {
    // flush the last page
    this.pages.push(this.current.join('\n'));

    const objects: string[] = [];
    const pageObjNumbers: number[] = [];
    // Object layout:
    //  1 Catalog, 2 Pages, 3 Font F1, 4 Font F2, then (Page, Content) pairs.
    const firstPageObj = 5;
    this.pages.forEach((_, i) => pageObjNumbers.push(firstPageObj + i * 2));

    objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objects[2] = `<< /Type /Pages /Count ${this.pages.length} /Kids [${pageObjNumbers
      .map((n) => `${n} 0 R`)
      .join(' ')}] >>`;
    objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
    objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;

    this.pages.forEach((content, i) => {
      const pageObj = firstPageObj + i * 2;
      const contentObj = pageObj + 1;
      objects[pageObj] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`;
      const stream = content;
      objects[contentObj] =
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
    });

    let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const xref: number[] = [];
    for (let i = 1; i < objects.length; i++) {
      if (!objects[i]) continue;
      xref[i] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefStart = Buffer.byteLength(pdf, 'latin1');
    const count = objects.length;
    pdf += `xref\n0 ${count}\n`;
    pdf += `0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) {
      pdf += objects[i]
        ? `${String(xref[i]).padStart(10, '0')} 00000 n \n`
        : `0000000000 00000 f \n`;
    }
    pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    return Buffer.from(pdf, 'latin1');
  }
}
