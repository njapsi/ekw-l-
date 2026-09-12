import { describe, expect, it } from 'vitest';
import { PdfDocument } from './pdf/document.js';
import { measureText, wrapText } from './pdf/metrics.js';

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

describe('pdf metrics', () => {
  it('measures wider strings as wider', () => {
    expect(measureText('WWWWW', 12)).toBeGreaterThan(measureText('iiiii', 12));
    expect(measureText('Hello', 24)).toBeCloseTo(measureText('Hello', 12) * 2, 4);
  });

  it('wraps text to a width and never exceeds it', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog again and again', 120, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const ln of lines) expect(measureText(ln, 10)).toBeLessThanOrEqual(120 + 0.01);
  });

  it('hard-splits a word longer than the line', () => {
    const lines = wrapText('supercalifragilisticexpialidocious'.repeat(3), 60, 10);
    for (const ln of lines) expect(measureText(ln, 10)).toBeLessThanOrEqual(60 + 0.01);
  });
});

describe('PdfDocument', () => {
  it('emits a structurally valid single-page PDF', () => {
    const doc = new PdfDocument({ footerText: 'footer' });
    doc.title('Report title');
    doc.heading('Section');
    doc.paragraph('A paragraph of body text.');
    doc.keyValue('Metric', '123');
    doc.table(['A', 'B'], [['1', '2']]);
    const out = text(doc.toBytes());
    expect(out.startsWith('%PDF-1.4')).toBe(true);
    expect(out.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(out).toContain('/Type /Catalog');
    expect(out).toContain('/BaseFont /Helvetica');
    expect(out).toContain('xref');
    expect(out).toContain('startxref');
    expect(out).toContain('(Report title)');
  });

  it('adds pages when content overflows', () => {
    const doc = new PdfDocument();
    for (let i = 0; i < 200; i++)
      doc.paragraph(`line ${i} with a bit of text to take vertical space`);
    const out = text(doc.toBytes());
    const pageCount = (out.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
    expect(out).toContain(`/Count ${pageCount}`);
  });

  it('is deterministic — same content produces identical bytes', () => {
    const make = () => {
      const d = new PdfDocument({ footerText: 'x' });
      d.title('T');
      d.heading('H');
      d.paragraph('body');
      return Buffer.from(d.toBytes()).toString('base64');
    };
    expect(make()).toEqual(make());
  });

  it('escapes PDF string metacharacters', () => {
    const doc = new PdfDocument();
    doc.paragraph('parens ( ) and a backslash \\ end');
    const out = text(doc.toBytes());
    expect(out).toContain('parens \\( \\) and a backslash \\\\ end');
  });
});
