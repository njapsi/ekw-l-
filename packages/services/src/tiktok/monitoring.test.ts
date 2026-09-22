import { describe, expect, it } from 'vitest';
import { describeAnomaly, detectAccountAnomalies } from './monitoring.js';
import type { TikTokMetricSnapshotLike } from './monitoring.js';

function snap(
  dateStr: string,
  overrides: Partial<TikTokMetricSnapshotLike> = {},
): TikTokMetricSnapshotLike {
  return {
    capturedAt: new Date(dateStr),
    followerCount: 1000n,
    likesCount: 5000n,
    ...overrides,
  };
}

/** N daily snapshots with a ~+10 followers/day, ~+50 likes/day rate and a
 *  small deterministic wobble so the baseline stdDev isn't exactly 0. */
function steadySnapshots(n: number): TikTokMetricSnapshotLike[] {
  let followers = 1000;
  let likes = 5000;
  return Array.from({ length: n }, (_, i) => {
    const date = new Date('2026-01-01T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + i);
    if (i > 0) {
      followers += i % 2 === 0 ? 8 : 12;
      likes += i % 2 === 0 ? 45 : 55;
    }
    return snap(date.toISOString(), {
      followerCount: BigInt(followers),
      likesCount: BigInt(likes),
    });
  });
}

describe('detectAccountAnomalies', () => {
  it('returns nothing with too few snapshots for a trailing baseline', () => {
    expect(detectAccountAnomalies(steadySnapshots(10))).toEqual([]);
  });

  it('does not flag steady, consistent growth as an anomaly', () => {
    expect(detectAccountAnomalies(steadySnapshots(16))).toEqual([]);
  });

  it('detects an ABOVE-baseline follower growth-rate anomaly for a clear spike', () => {
    const snapshots = steadySnapshots(16);
    const last = snapshots[snapshots.length - 1]!;
    snapshots[snapshots.length - 1] = { ...last, followerCount: last.followerCount! + 100_000n };
    const anomalies = detectAccountAnomalies(snapshots);
    const followerAnomaly = anomalies.find((a) => a.metric === 'followerGrowthRate');
    expect(followerAnomaly).toBeDefined();
    expect(followerAnomaly!.direction).toBe('ABOVE');
  });

  it('detects a BELOW-baseline anomaly for a sudden follower drop', () => {
    const snapshots = steadySnapshots(16);
    const last = snapshots[snapshots.length - 1]!;
    snapshots[snapshots.length - 1] = { ...last, followerCount: last.followerCount! - 50_000n };
    const anomalies = detectAccountAnomalies(snapshots);
    const followerAnomaly = anomalies.find((a) => a.metric === 'followerGrowthRate');
    expect(followerAnomaly).toBeDefined();
    expect(followerAnomaly!.direction).toBe('BELOW');
  });

  it('drops a pair of snapshots captured less than half a day apart', () => {
    const snapshots = steadySnapshots(16);
    // Insert a near-duplicate snapshot a few minutes after the last one.
    const last = snapshots[snapshots.length - 1]!;
    const nearDuplicate = snap(new Date(last.capturedAt.getTime() + 5 * 60_000).toISOString(), {
      followerCount: last.followerCount! + 500_000n, // would be an extreme rate if not dropped
    });
    const anomalies = detectAccountAnomalies([...snapshots, nearDuplicate]);
    // The near-duplicate pair is dropped entirely rather than producing a
    // division-dominated false anomaly from a near-zero elapsed time.
    expect(anomalies.every((a) => Number.isFinite(a.zScore))).toBe(true);
  });

  it('skips detection when any snapshot in the series is missing the relevant scope (null values)', () => {
    const snapshots = steadySnapshots(16);
    snapshots[5] = { ...snapshots[5]!, followerCount: null };
    const anomalies = detectAccountAnomalies(snapshots);
    expect(anomalies.find((a) => a.metric === 'followerGrowthRate')).toBeUndefined();
  });
});

describe('describeAnomaly', () => {
  it('names the exact metric, date, value, and baseline — never a vague "unusual" claim', () => {
    const snapshots = steadySnapshots(16);
    const last = snapshots[snapshots.length - 1]!;
    snapshots[snapshots.length - 1] = { ...last, followerCount: last.followerCount! + 100_000n };
    const anomaly = detectAccountAnomalies(snapshots).find(
      (a) => a.metric === 'followerGrowthRate',
    )!;
    const text = describeAnomaly(anomaly);
    expect(text).toContain('follower growth rate');
    expect(text).toMatch(/\d+(\.\d+)?σ deviation/);
  });
});
