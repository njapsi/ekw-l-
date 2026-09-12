/**
 * Small formatting + mapping helpers shared by the per-type fact gatherers.
 */
import type { Priority } from '@growth-agent/core';
import type { ReportRecommendation, ReportSeverity } from '@growth-agent/core';

export function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export function fmtInt(v: unknown): string {
  const n = toNum(v);
  return n == null ? '—' : new Intl.NumberFormat('en').format(Math.round(n));
}

export function fmtCompact(v: unknown): string {
  const n = toNum(v);
  return n == null
    ? '—'
    : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function fmtPct(v: unknown, digits = 1): string {
  const n = toNum(v);
  return n == null ? '—' : `${n.toFixed(digits)}%`;
}

export function fmtScore(v: unknown): string {
  const n = toNum(v);
  return n == null ? '—' : `${Math.round(n)}/100`;
}

const PRIORITY_SET = new Set<Priority>(['critical', 'high', 'medium', 'low']);
const EFFORT_SET = new Set(['trivial', 'small', 'medium', 'large']);

export function normalizePriority(v: unknown): Priority {
  const s = (typeof v === 'string' ? v : '').toLowerCase();
  return PRIORITY_SET.has(s as Priority) ? (s as Priority) : 'medium';
}

export function normalizeEffort(v: unknown): ReportRecommendation['effort'] {
  const s = (typeof v === 'string' ? v : '').toLowerCase();
  return (EFFORT_SET.has(s) ? s : 'medium') as ReportRecommendation['effort'];
}

export function priorityToSeverity(p: Priority): ReportSeverity {
  switch (p) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

interface RecRowLike {
  id: string;
  title: string;
  explanation?: string | null;
  reasoning?: string | null;
  priority?: string | null;
  effort?: string | null;
  confidence?: number | null;
  expectedImpact?: string | null;
  recommendedActions?: string[] | null;
  implementationInstructions?: string | null;
  status?: string | null;
}

/** Map a `Recommendation` DB row to the report's recommendation shape. */
export function recFromRow(row: RecRowLike): ReportRecommendation {
  const actions =
    row.recommendedActions && row.recommendedActions.length > 0
      ? row.recommendedActions
      : [row.implementationInstructions?.trim() || 'Review and action this recommendation.'];
  return {
    id: row.id,
    title: row.title,
    why: (row.explanation ?? row.reasoning ?? 'See the detailed analysis.').trim(),
    actions: actions
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 8),
    priority: normalizePriority(row.priority),
    effort: normalizeEffort(row.effort),
    confidence:
      typeof row.confidence === 'number' && row.confidence >= 0 && row.confidence <= 1
        ? row.confidence
        : 0.5,
    expectedImpact: (row.expectedImpact ?? 'Impact not quantified.').trim(),
  };
}

export const OPEN_REC_STATUSES = ['PROPOSED', 'APPROVED'];

export function isOpenRec(status: string | null | undefined): boolean {
  return OPEN_REC_STATUSES.includes(String(status ?? 'PROPOSED'));
}

/** A stable fact-sheet accumulator for the grounded summary pass. */
export class FactSheet {
  private readonly facts: Array<{ id: string; text: string }> = [];
  push(text: string): void {
    if (text.trim()) this.facts.push({ id: `f${this.facts.length + 1}`, text: text.trim() });
  }
  all(): Array<{ id: string; text: string }> {
    return this.facts;
  }
}
