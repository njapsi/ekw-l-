/**
 * Deterministic CSV rendering of a report snapshot. One file with clearly
 * labelled sections (a blank line + a section header row between them) so it
 * opens cleanly in a spreadsheet. Pure — no dependency.
 */
import type { ReportSnapshot } from '@growth-agent/core';

type Cell = string | number | null | undefined;

function esc(value: Cell): string {
  const s = value == null ? '' : typeof value === 'number' ? String(value) : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(cells: Cell[]): string {
  return cells.map(esc).join(',');
}

export function snapshotToCsv(snapshot: ReportSnapshot): string {
  const lines: string[] = [];
  const s = snapshot;

  lines.push(row(['Report', s.meta.title]));
  lines.push(row(['Type', s.meta.type]));
  lines.push(row(['Subject', s.meta.subjectLabel]));
  lines.push(row(['Generated at', s.meta.generatedAt]));
  lines.push(row(['Data through', s.meta.dataThrough ?? '']));
  lines.push('');

  lines.push(row(['# Executive summary']));
  lines.push(row(['Headline', s.executiveSummary.headline]));
  s.executiveSummary.paragraphs.forEach((p, i) => lines.push(row([`Paragraph ${i + 1}`, p])));
  lines.push('');

  lines.push(row(['# Key metrics']));
  lines.push(row(['Metric', 'Value', 'Previous', 'Change %', 'Direction', 'Note']));
  for (const m of s.keyMetrics) {
    lines.push(
      row([
        m.label,
        m.value,
        m.delta?.previous ?? '',
        m.delta?.changePct ?? '',
        m.delta?.direction ?? '',
        m.note ?? '',
      ]),
    );
  }
  lines.push('');

  lines.push(row(['# Problems']));
  lines.push(row(['Severity', 'Title', 'Detail']));
  for (const p of s.problems) lines.push(row([p.severity, p.title, p.detail]));
  lines.push('');

  lines.push(row(['# Opportunities']));
  lines.push(row(['Title', 'Detail', 'Potential', 'Effort']));
  for (const o of s.opportunities) {
    lines.push(row([o.title, o.detail, o.potential ?? '', o.effort ?? '']));
  }
  lines.push('');

  lines.push(row(['# Recommendations']));
  lines.push(
    row(['Priority', 'Title', 'Why', 'Actions', 'Effort', 'Confidence', 'Expected impact']),
  );
  for (const r of s.recommendations) {
    lines.push(
      row([
        r.priority,
        r.title,
        r.why,
        r.actions.join(' | '),
        r.effort,
        r.confidence,
        r.expectedImpact,
      ]),
    );
  }
  lines.push('');

  lines.push(row(['# Priority actions']));
  lines.push(row(['Rank', 'Title', 'Rationale', 'Effort']));
  for (const a of s.priorityActions) {
    lines.push(row([a.rank, a.title, a.rationale, a.effort ?? '']));
  }
  lines.push('');

  lines.push(row(['# Historical changes']));
  if (s.historicalChanges.comparedTo) {
    lines.push(row(['Compared to report', s.historicalChanges.comparedTo.reportId]));
    lines.push(row(['Metric', 'From', 'To', 'Change %', 'Direction']));
    for (const c of s.historicalChanges.changes) {
      lines.push(row([c.label, c.from, c.to, c.changePct ?? '', c.direction]));
    }
  }
  for (const n of s.historicalChanges.notes) lines.push(row(['Note', n]));
  lines.push('');

  if (s.dataGaps.length) {
    lines.push(row(['# Data gaps']));
    for (const d of s.dataGaps) lines.push(row([d]));
    lines.push('');
  }
  if (s.disclaimers.length) {
    lines.push(row(['# Disclaimers']));
    for (const d of s.disclaimers) lines.push(row([d]));
  }

  return lines.join('\r\n');
}
