/**
 * Anomaly detection over TikTok account snapshots (Phase 7, §34). TikTok's
 * Display API exposes no day-by-day time series at all — `TikTokMetric` is
 * an irregularly-spaced periodic snapshot table (one row per sync that had
 * the `user.info.stats` scope), never a daily table. This means the
 * trailing-N-calendar-days baseline `youtube/monitoring.ts` uses does not
 * directly apply: two snapshots might be captured hours apart, or weeks
 * apart, depending on how often syncs actually ran.
 *
 * To stay honest about that, this module works over **per-day growth rates
 * between consecutive snapshots** rather than raw snapshot values: each
 * consecutive pair is turned into a "change per elapsed day" figure, which
 * *is* comparable across unevenly-spaced snapshots, and the anomaly check
 * (a transparent trailing mean/stdDev z-score, same documented thresholds as
 * YouTube's) runs over that normalized rate series. A pair separated by less
 * than half a day is dropped rather than risking a division blow-up from a
 * near-zero elapsed time.
 */
export interface TikTokMetricSnapshotLike {
  capturedAt: Date;
  followerCount: bigint | null;
  likesCount: bigint | null;
}

export type TikTokAnomalyMetric = 'followerGrowthRate' | 'likesGrowthRate';
export type TikTokAnomalyDirection = 'ABOVE' | 'BELOW';

export interface TikTokAnomaly {
  metric: TikTokAnomalyMetric;
  direction: TikTokAnomalyDirection;
  /** The snapshot date this rate was computed up to. */
  date: string;
  /** Change per elapsed day between the two most recent snapshots. */
  value: number;
  baselineMean: number;
  baselineStdDev: number;
  zScore: number;
  severity: 'NOTICE' | 'WARNING';
}

/** Minimum trailing rate readings before a baseline is trustworthy — below
 *  this, detection is skipped rather than guessed (needs at least this many
 *  snapshot-to-snapshot intervals, i.e. one more raw snapshot). */
const MIN_BASELINE_RATES = 14;
const NOTICE_Z = 2.5;
const WARNING_Z = 4;
/** A pair closer together than this is dropped — the rate would be
 *  dominated by noise from a near-zero elapsed-time denominator. */
const MIN_ELAPSED_DAYS = 0.5;

function mean(nums: number[]): number {
  return nums.reduce((s, x) => s + x, 0) / nums.length;
}
function stdDev(nums: number[], m: number): number {
  const variance = nums.reduce((s, x) => s + (x - m) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

interface RatePoint {
  date: Date;
  followerRate: number | null;
  likesRate: number | null;
}

function toRates(snapshots: TikTokMetricSnapshotLike[]): RatePoint[] {
  const sorted = [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const rates: RatePoint[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const elapsedDays = (curr.capturedAt.getTime() - prev.capturedAt.getTime()) / 86_400_000;
    if (elapsedDays < MIN_ELAPSED_DAYS) continue;
    const followerRate =
      curr.followerCount != null && prev.followerCount != null
        ? (Number(curr.followerCount) - Number(prev.followerCount)) / elapsedDays
        : null;
    const likesRate =
      curr.likesCount != null && prev.likesCount != null
        ? (Number(curr.likesCount) - Number(prev.likesCount)) / elapsedDays
        : null;
    rates.push({ date: curr.capturedAt, followerRate, likesRate });
  }
  return rates;
}

function detectOnSeries(
  rates: RatePoint[],
  metric: TikTokAnomalyMetric,
  extract: (r: RatePoint) => number | null,
): TikTokAnomaly | null {
  const values = rates.map(extract);
  if (values.some((v) => v == null)) return null; // needs a complete trailing series
  const nums = values as number[];
  if (nums.length < MIN_BASELINE_RATES + 1) return null;

  const latest = nums[nums.length - 1]!;
  const baseline = nums.slice(-(MIN_BASELINE_RATES + 1), -1);
  const m = mean(baseline);
  const sd = stdDev(baseline, m);
  if (sd === 0) return null;

  const zScore = (latest - m) / sd;
  const absZ = Math.abs(zScore);
  if (absZ < NOTICE_Z) return null;

  return {
    metric,
    direction: zScore > 0 ? 'ABOVE' : 'BELOW',
    date: rates[rates.length - 1]!.date.toISOString().slice(0, 10),
    value: Math.round(latest * 100) / 100,
    baselineMean: Math.round(m * 100) / 100,
    baselineStdDev: Math.round(sd * 100) / 100,
    zScore: Math.round(zScore * 100) / 100,
    severity: absZ >= WARNING_Z ? 'WARNING' : 'NOTICE',
  };
}

/**
 * Detects an unusual follower- or likes-growth rate compared to this
 * account's own trailing rate history. Requires at least `MIN_BASELINE_RATES
 * + 2` snapshots with the relevant scope granted (fewer than that returns no
 * anomalies rather than guessing from a thin baseline).
 */
export function detectAccountAnomalies(snapshots: TikTokMetricSnapshotLike[]): TikTokAnomaly[] {
  const rates = toRates(snapshots);
  const anomalies: TikTokAnomaly[] = [];
  const followerAnomaly = detectOnSeries(rates, 'followerGrowthRate', (r) => r.followerRate);
  if (followerAnomaly) anomalies.push(followerAnomaly);
  const likesAnomaly = detectOnSeries(rates, 'likesGrowthRate', (r) => r.likesRate);
  if (likesAnomaly) anomalies.push(likesAnomaly);
  return anomalies;
}

const METRIC_LABEL: Record<TikTokAnomalyMetric, string> = {
  followerGrowthRate: 'follower growth rate',
  likesGrowthRate: 'likes growth rate',
};

export function describeAnomaly(a: TikTokAnomaly): string {
  const dir = a.direction === 'ABOVE' ? 'above' : 'below';
  return `${METRIC_LABEL[a.metric]} through ${a.date} (${a.value.toLocaleString('en-US')}/day) was ${dir} the trailing average (${a.baselineMean.toLocaleString('en-US')}/day ± ${a.baselineStdDev.toLocaleString('en-US')}), a ${a.zScore.toFixed(1)}σ deviation.`;
}
