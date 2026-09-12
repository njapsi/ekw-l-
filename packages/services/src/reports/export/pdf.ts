/**
 * Lay out a report snapshot into the minimal PDF writer. Text-only,
 * professional-looking, deterministic. No charts (docs/REPORTING.md §7).
 */
import type { ReportSnapshot } from '@growth-agent/core';
import { PdfDocument } from '../pdf/document.js';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

function arrow(direction: string): string {
  if (direction === 'up') return '(up)';
  if (direction === 'down') return '(down)';
  if (direction === 'flat') return '(flat)';
  return '';
}

export function snapshotToPdf(snapshot: ReportSnapshot): Uint8Array {
  const s = snapshot;
  const doc = new PdfDocument({
    footerText: `${s.meta.orgName} · ${s.meta.title} · generated ${fmtDate(s.meta.generatedAt)}${
      s.meta.isPublic ? ' · shared copy (redacted)' : ''
    }`,
  });

  doc.title(s.meta.title);
  doc.paragraph(
    `Subject: ${s.meta.subjectLabel}    Generated: ${fmtDate(s.meta.generatedAt)}    Data through: ${fmtDate(
      s.meta.dataThrough,
    )}`,
    { size: 9 },
  );

  doc.heading('Executive summary');
  doc.paragraph(s.executiveSummary.headline, { font: 'bold', size: 11 });
  for (const p of s.executiveSummary.paragraphs) doc.paragraph(p);

  doc.heading('Key metrics');
  if (s.keyMetrics.length === 0) {
    doc.paragraph('No metrics available.');
  } else {
    doc.table(
      ['Metric', 'Value', 'Change vs previous'],
      s.keyMetrics.map((m) => [
        m.label,
        m.value,
        m.delta
          ? `${m.delta.previous} -> ${m.value} ${
              m.delta.changePct != null
                ? `(${m.delta.changePct > 0 ? '+' : ''}${m.delta.changePct}%)`
                : ''
            } ${arrow(m.delta.direction)}`
          : 'no prior report',
      ]),
    );
  }

  doc.heading('Problems');
  if (s.problems.length === 0) {
    doc.paragraph('No problems identified.');
  } else {
    for (const p of s.problems) {
      doc.paragraph(`[${p.severity.toUpperCase()}] ${p.title}`, { font: 'bold', size: 10, gap: 1 });
      doc.paragraph(p.detail, { size: 9 });
      for (const e of p.evidence) doc.bullet(e);
    }
  }

  doc.heading('Opportunities');
  if (s.opportunities.length === 0) {
    doc.paragraph('No opportunities identified.');
  } else {
    for (const o of s.opportunities) {
      doc.paragraph(o.title, { font: 'bold', size: 10, gap: 1 });
      doc.paragraph(
        `${o.detail}${o.potential ? `  Potential: ${o.potential}.` : ''}${
          o.effort ? `  Effort: ${o.effort}.` : ''
        }`,
        { size: 9 },
      );
    }
  }

  doc.heading('Recommendations');
  if (s.recommendations.length === 0) {
    doc.paragraph('No open recommendations.');
  } else {
    for (const r of s.recommendations) {
      doc.paragraph(`[${r.priority.toUpperCase()}] ${r.title}`, { font: 'bold', size: 10, gap: 1 });
      doc.paragraph(`Why: ${r.why}`, { size: 9, gap: 1 });
      for (const a of r.actions) doc.bullet(a);
      doc.paragraph(
        `Effort: ${r.effort} · Confidence: ${Math.round(r.confidence * 100)}% · Expected impact: ${r.expectedImpact}`,
        { size: 8 },
      );
    }
  }

  doc.heading('Priority actions');
  if (s.priorityActions.length === 0) {
    doc.paragraph('No priority actions.');
  } else {
    for (const a of s.priorityActions) {
      doc.paragraph(`${a.rank}. ${a.title}`, { font: 'bold', size: 10, gap: 1 });
      doc.paragraph(`${a.rationale}${a.effort ? `  (effort: ${a.effort})` : ''}`, { size: 9 });
    }
  }

  doc.heading('Historical changes');
  if (!s.historicalChanges.comparedTo) {
    doc.paragraph(
      s.historicalChanges.notes[0] ??
        'This is the first report of its type; the next one will show what changed.',
    );
  } else {
    if (s.historicalChanges.changes.length > 0) {
      doc.table(
        ['Metric', 'From', 'To', 'Change'],
        s.historicalChanges.changes.map((c) => [
          c.label,
          c.from,
          c.to,
          `${c.changePct != null ? `${c.changePct > 0 ? '+' : ''}${c.changePct}% ` : ''}${arrow(c.direction)}`,
        ]),
      );
    }
    for (const n of s.historicalChanges.notes) doc.paragraph(n, { size: 9 });
  }

  if (s.dataGaps.length > 0) {
    doc.heading('Data gaps');
    for (const d of s.dataGaps) doc.bullet(d);
  }

  doc.heading('Disclaimers');
  for (const d of s.disclaimers) doc.bullet(d);

  return doc.toBytes();
}
