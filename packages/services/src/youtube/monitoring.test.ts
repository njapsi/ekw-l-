import { describe, expect, it } from 'vitest';
import { describeAnomaly, detectAnomalies } from './monitoring.js';
import type { DailyMetricLike } from './metrics.js';

function day(dateStr: string, overrides: Partial<DailyMetricLike> = {}): DailyMetricLike {
  return {
    date: new Date(dateStr),
    views: 1000n,
    estimatedMinutesWatched: 5000n,
    likes: 50n,
    comments: 10n,
    shares: 5n,
    subscribersGained: 20n,
    subscribersLost: 5n,
    estimatedRevenue: null,
    ...overrides,
  };
}

function baselineDays(n: number, views = 1000): DailyMetricLike[] {
  return Array.from({ length: n }, (_, i) => {
    const date = new Date('2026-01-01T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + i);
    // Small deterministic wobble so stdDev isn't exactly 0.
    const wobble = i % 2 === 0 ? 20 : -20;
    return day(date.toISOString(), { views: BigInt(views + wobble) });
  });
}

describe('detectAnomalies', () => {
  it('returns nothing with fewer than 15 days of history', () => {
    const daily = baselineDays(10);
    expect(detectAnomalies(daily)).toEqual([]);
  });

  it('detects an ABOVE-baseline views anomaly for a clear spike', () => {
    const daily = [...baselineDays(14), day('2026-01-15T00:00:00Z', { views: 100_000n })];
    const anomalies = detectAnomalies(daily);
    const viewsAnomaly = anomalies.find((a) => a.metric === 'views');
    expect(viewsAnomaly).toBeDefined();
    expect(viewsAnomaly!.direction).toBe('ABOVE');
    expect(viewsAnomaly!.zScore).toBeGreaterThan(0);
  });

  it('detects a BELOW-baseline views anomaly for a clear drop', () => {
    const daily = [...baselineDays(14), day('2026-01-15T00:00:00Z', { views: 1n })];
    const anomalies = detectAnomalies(daily);
    const viewsAnomaly = anomalies.find((a) => a.metric === 'views');
    expect(viewsAnomaly).toBeDefined();
    expect(viewsAnomaly!.direction).toBe('BELOW');
  });

  it('does not flag normal day-to-day variation as an anomaly', () => {
    // The latest day continues the same +/-20 wobble pattern as the baseline.
    const daily = baselineDays(15);
    expect(detectAnomalies(daily)).toEqual([]);
  });

  it('classifies a very extreme deviation as WARNING, a moderate one as NOTICE', () => {
    // Baseline wobbles +/-20 around 1000 (stdDev ~20). A +65 offset lands
    // at ~3.25 sigma (between the 2.5 NOTICE and 4 WARNING thresholds).
    const modestSpike = [...baselineDays(14), day('2026-01-15T00:00:00Z', { views: 1065n })];
    const extremeSpike = [...baselineDays(14), day('2026-01-15T00:00:00Z', { views: 1_000_000n })];
    const modest = detectAnomalies(modestSpike).find((a) => a.metric === 'views');
    const extreme = detectAnomalies(extremeSpike).find((a) => a.metric === 'views');
    expect(extreme?.severity).toBe('WARNING');
    expect(modest?.severity).toBe('NOTICE');
  });

  it('skips a metric whose baseline has zero variance (flat data)', () => {
    const flatBaseline = Array.from({ length: 14 }, (_, i) => {
      const date = new Date('2026-01-01T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + i);
      return day(date.toISOString(), { views: 1000n });
    });
    const daily = [...flatBaseline, day('2026-01-15T00:00:00Z', { views: 5000n })];
    // Views baseline is perfectly flat (stdDev 0) -> skipped, no crash/Infinity.
    const anomalies = detectAnomalies(daily);
    expect(anomalies.every((a) => Number.isFinite(a.zScore))).toBe(true);
  });
});

describe('describeAnomaly', () => {
  it('names the exact metric, date, value, and baseline — never a vague "unusual" claim', () => {
    const daily = [...baselineDays(14), day('2026-01-15T00:00:00Z', { views: 100_000n })];
    const anomaly = detectAnomalies(daily).find((a) => a.metric === 'views')!;
    const text = describeAnomaly(anomaly);
    expect(text).toContain('2026-01-15');
    expect(text).toMatch(/\d+(\.\d+)?σ deviation/);
  });
});
