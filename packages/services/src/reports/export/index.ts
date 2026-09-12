import type { ReportSnapshot } from '@growth-agent/core';
import { snapshotToCsv } from './csv.js';
import { snapshotToPdf } from './pdf.js';

export { snapshotToCsv } from './csv.js';
export { snapshotToPdf } from './pdf.js';

export type ExportFormat = 'pdf' | 'csv' | 'json';

export interface RenderedExport {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}

export function renderExport(snapshot: ReportSnapshot, format: ExportFormat): RenderedExport {
  switch (format) {
    case 'pdf':
      return { bytes: snapshotToPdf(snapshot), contentType: 'application/pdf', extension: 'pdf' };
    case 'csv':
      return {
        bytes: new TextEncoder().encode(snapshotToCsv(snapshot)),
        contentType: 'text/csv; charset=utf-8',
        extension: 'csv',
      };
    case 'json':
      return {
        bytes: new TextEncoder().encode(JSON.stringify(snapshot, null, 2)),
        contentType: 'application/json; charset=utf-8',
        extension: 'json',
      };
    default: {
      const _x: never = format;
      throw new Error(`unknown export format ${String(_x)}`);
    }
  }
}

export function exportFilename(snapshot: ReportSnapshot, format: ExportFormat): string {
  const date = snapshot.meta.generatedAt.slice(0, 10);
  return `${slugify(snapshot.meta.title)}-${date}.${format}`;
}
