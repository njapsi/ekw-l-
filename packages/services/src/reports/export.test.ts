import { describe, expect, it } from 'vitest';
import { snapshotToCsv } from './export/csv.js';
import { exportFilename, renderExport } from './export/index.js';
import { snapshotToPdf } from './export/pdf.js';
import { sampleSnapshot } from './sample.js';

describe('snapshotToCsv', () => {
  const csv = snapshotToCsv(sampleSnapshot());

  it('has a labelled section for each of the seven sections', () => {
    for (const header of [
      '# Executive summary',
      '# Key metrics',
      '# Problems',
      '# Opportunities',
      '# Recommendations',
      '# Priority actions',
      '# Historical changes',
    ]) {
      expect(csv).toContain(header);
    }
  });

  it('escapes commas, quotes and newlines', () => {
    const s = sampleSnapshot({
      problems: [
        {
          id: 'p',
          title: 'Has, a comma and "quotes"',
          detail: 'line one\nline two',
          severity: 'low',
          evidence: [],
        },
      ],
    });
    const out = snapshotToCsv(s);
    expect(out).toContain('"Has, a comma and ""quotes"""');
    expect(out).toContain('"line one\nline two"');
  });

  it('includes metric rows with previous value + change', () => {
    expect(csv).toMatch(/Subscribers,12\.3K,11\.9K,3\.4,up/);
  });
});

describe('snapshotToPdf', () => {
  it('produces a PDF that contains the section headings and the exec headline', () => {
    const bytes = snapshotToPdf(sampleSnapshot());
    const s = Buffer.from(bytes).toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('(Executive summary)');
    expect(s).toContain('(Key metrics)');
    expect(s).toContain('(Historical changes)');
  });
});

describe('renderExport / exportFilename', () => {
  it('maps each format to bytes + a content type', () => {
    const snap = sampleSnapshot();
    expect(renderExport(snap, 'pdf').contentType).toBe('application/pdf');
    expect(renderExport(snap, 'csv').contentType).toContain('text/csv');
    const json = renderExport(snap, 'json');
    expect(JSON.parse(Buffer.from(json.bytes).toString('utf8')).meta.type).toBe('YOUTUBE');
  });

  it('builds a dated, slugged filename', () => {
    expect(exportFilename(sampleSnapshot(), 'pdf')).toBe(
      'youtube-performance-acme-channel-2026-09-08.pdf',
    );
  });
});
