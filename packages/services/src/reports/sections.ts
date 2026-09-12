/**
 * Deterministic assembly of the six non-summary report sections from a
 * `GatheredReport`, plus the "Historical Changes" diff against the previous
 * snapshot of the same type. Nothing here calls a model or invents a number.
 */
import type {
  HistoricalChanges,
  KeyMetric,
  MetricDirection,
  PriorityAction,
  ReportSnapshot,
} from '@growth-agent/core';
import type { GatheredReport, MetricInput } from './schemas.js';

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function direction(changePct: number | null): MetricDirection {
  if (changePct == null) return 'unknown';
  if (Math.abs(changePct) < 0.5) return 'flat';
  return changePct > 0 ? 'up' : 'down';
}

function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null;
  return Number((((to - from) / Math.abs(from)) * 100).toFixed(1));
}

function previousMetric(
  prev: ReportSnapshot | null,
  key: string,
): { value: string; raw: number | null } | null {
  if (!prev) return null;
  const m = prev.keyMetrics.find((x) => keyMetricKey(x) === key);
  return m ? { value: m.value, raw: m.raw } : null;
}

/** We stash the stable key on the metric label lookup via a parallel map, but
 *  since `KeyMetric` has no key field we match on label instead. */
function keyMetricKey(m: KeyMetric): string {
  return m.label;
}

export function buildKeyMetrics(
  metrics: MetricInput[],
  previous: ReportSnapshot | null,
): KeyMetric[] {
  return metrics.map((m) => {
    const prev = previousMetric(previous, m.label);
    let delta: KeyMetric['delta'] = null;
    if (prev) {
      const changePct = m.raw != null && prev.raw != null ? pctChange(prev.raw, m.raw) : null;
      delta = {
        previous: prev.value,
        changePct,
        direction: direction(changePct),
      };
    }
    return {
      label: m.label,
      value: m.value,
      raw: m.raw,
      unit: m.unit,
      delta,
      note: m.note,
    };
  });
}

export function buildHistoricalChanges(
  metrics: MetricInput[],
  previous: ReportSnapshot | null,
  previousMeta: { reportId: string; generatedAt: string } | null,
): HistoricalChanges {
  if (!previous || !previousMeta) {
    return {
      comparedTo: null,
      changes: [],
      notes: [
        'This is the first report of this type — there is nothing to compare against yet. The next report will show what changed.',
      ],
    };
  }
  const changes: HistoricalChanges['changes'] = [];
  for (const m of metrics) {
    const prev = previousMetric(previous, m.label);
    if (!prev) continue;
    if (prev.value === m.value) continue;
    const changePct = m.raw != null && prev.raw != null ? pctChange(prev.raw, m.raw) : null;
    changes.push({
      label: m.label,
      from: prev.value,
      to: m.value,
      changePct,
      direction: direction(changePct),
    });
  }
  const notes: string[] = [];
  if (changes.length === 0) {
    notes.push('No tracked metric changed materially since the previous report.');
  }
  return { comparedTo: previousMeta, changes, notes };
}

export function buildPriorityActions(g: GatheredReport): PriorityAction[] {
  const ranked = [...g.recommendations].sort((a, b) => {
    const p = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (p !== 0) return p;
    return b.confidence - a.confidence;
  });
  return ranked.slice(0, 5).map((r, i) => ({
    rank: i + 1,
    title: r.title,
    rationale: r.why,
    effort: r.effort,
  }));
}

export function sortProblems(g: GatheredReport): GatheredReport['problems'] {
  return [...g.problems].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );
}

export interface AssembledSections {
  keyMetrics: KeyMetric[];
  problems: GatheredReport['problems'];
  opportunities: GatheredReport['opportunities'];
  recommendations: GatheredReport['recommendations'];
  priorityActions: PriorityAction[];
  historicalChanges: HistoricalChanges;
}

export function assembleSections(
  g: GatheredReport,
  previous: ReportSnapshot | null,
  previousMeta: { reportId: string; generatedAt: string } | null,
): AssembledSections {
  return {
    keyMetrics: buildKeyMetrics(g.metrics, previous),
    problems: sortProblems(g),
    opportunities: g.opportunities,
    recommendations: [...g.recommendations].sort(
      (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9),
    ),
    priorityActions: buildPriorityActions(g),
    historicalChanges: buildHistoricalChanges(g.metrics, previous, previousMeta),
  };
}
