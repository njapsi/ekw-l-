/**
 * Anomaly detection over daily channel metrics (Phase 6, Parts 43-44). A
 * transparent baseline (trailing mean + standard deviation), never a black
 * -box "AI thinks this is unusual" — every anomaly names the exact baseline
 * and the exact deviation so it can be checked (Part 44: "Use statistical or
 * transparent baseline methods. Do not label every fluctuation an anomaly").
 */
import type { DailyMetricLike } from './metrics.js';

export type AnomalyMetric = 'views' | 'estimatedMinutesWatched' | 'netSubscribers';
export type AnomalyDirection = 'ABOVE' | 'BELOW';

export interface Anomaly {
  metric: AnomalyMetric;
  direction: AnomalyDirection;
  date: string;
  value: number;
  baselineMean: number;
  baselineStdDev: number;
  /** (value - mean) / stdDev. */
  zScore: number;
  severity: 'NOTICE' | 'WARNING';
}

/** Minimum trailing history before a baseline is trustworthy — below this,
 *  detection is skipped entirely rather than guessed (Part 13). */
const MIN_BASELINE_DAYS = 14;
/** Z-score thresholds — documented, fixed (Part 44), never per-org tuned by
 *  a model. 2.5σ ≈ notice-worthy; 4σ ≈ warning-worthy for a daily count
 *  metric, which is naturally noisy day to day. */
const NOTICE_Z = 2.5;
const WARNING_Z = 4;

function mean(nums: number[]): number {
  return nums.reduce((s, x) => s + x, 0) / nums.length;
}
function stdDev(nums: number[], m: number): number {
  const variance = nums.reduce((s, x) => s + (x - m) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function netSubs(d: DailyMetricLike): number {
  return Number(d.subscribersGained) - Number(d.subscribersLost);
}

const EXTRACT: Record<AnomalyMetric, (d: DailyMetricLike) => number> = {
  views: (d) => Number(d.views),
  estimatedMinutesWatched: (d) => Number(d.estimatedMinutesWatched),
  netSubscribers: netSubs,
};

/**
 * Compares the most recent day against the trailing `MIN_BASELINE_DAYS`
 * days before it (excluding the day itself, so the baseline can't include
 * the value being tested). Requires the daily rows to already be sorted
 * ascending by date, matching every other caller's convention in this
 * module (`read.ts`, `windowTotals`).
 */
export function detectAnomalies(daily: DailyMetricLike[]): Anomaly[] {
  if (daily.length < MIN_BASELINE_DAYS + 1) return [];

  const latest = daily[daily.length - 1]!;
  const baseline = daily.slice(-(MIN_BASELINE_DAYS + 1), -1);
  const anomalies: Anomaly[] = [];

  for (const metric of Object.keys(EXTRACT) as AnomalyMetric[]) {
    const extract = EXTRACT[metric];
    const baselineValues = baseline.map(extract);
    const m = mean(baselineValues);
    const sd = stdDev(baselineValues, m);
    if (sd === 0) continue; // a perfectly flat baseline can't produce a meaningful z-score

    const value = extract(latest);
    const zScore = (value - m) / sd;
    const absZ = Math.abs(zScore);
    if (absZ < NOTICE_Z) continue;

    anomalies.push({
      metric,
      direction: zScore > 0 ? 'ABOVE' : 'BELOW',
      date: latest.date.toISOString().slice(0, 10),
      value,
      baselineMean: Math.round(m * 100) / 100,
      baselineStdDev: Math.round(sd * 100) / 100,
      zScore: Math.round(zScore * 100) / 100,
      severity: absZ >= WARNING_Z ? 'WARNING' : 'NOTICE',
    });
  }

  return anomalies;
}

const METRIC_LABEL: Record<AnomalyMetric, string> = {
  views: 'daily views',
  estimatedMinutesWatched: 'daily watch minutes',
  netSubscribers: 'net subscribers',
};

export function describeAnomaly(a: Anomaly): string {
  const dir = a.direction === 'ABOVE' ? 'above' : 'below';
  return `${METRIC_LABEL[a.metric]} on ${a.date} (${a.value.toLocaleString('en-US')}) was ${dir} the trailing ${MIN_BASELINE_DAYS}-day average (${a.baselineMean.toLocaleString('en-US')} ± ${a.baselineStdDev.toLocaleString('en-US')}), a ${a.zScore.toFixed(1)}σ deviation.`;
}
