import { describe, expect, it } from 'vitest';
import { NEVER_GUARANTEE_NOTICE, assessMonetization } from './monetization.js';
import type { DailyMetricLike } from './metrics.js';

function dailySeries(days: number, minutesPerDay: number): DailyMetricLike[] {
  const rows: DailyMetricLike[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    rows.push({
      date: new Date(now - i * 86_400_000),
      views: 100n,
      estimatedMinutesWatched: BigInt(minutesPerDay),
      likes: 5n,
      comments: 1n,
      shares: 0n,
      subscribersGained: 2n,
      subscribersLost: 0n,
      estimatedRevenue: null,
    });
  }
  return rows;
}

describe('assessMonetization', () => {
  it('separates official / api / user / estimate and never guarantees', () => {
    const a = assessMonetization({
      subscriberCount: 1500n,
      hiddenSubscriberCount: false,
      daily: dailySeries(365, 900), // ~5475 h over the year
      analyticsSyncedThrough: new Date(),
      attestations: { twoStep: true },
    });

    expect(a.official.every((r) => r.kind === 'fact' && r.source)).toBe(true);
    expect(a.apiData.length).toBeGreaterThan(0);
    expect(a.userProvided.every((u) => u.kind === 'assumption')).toBe(true);
    expect(a.estimate.kind).toBe('prediction');
    expect(a.estimate.confidence).toBeGreaterThan(0);
    expect(a.estimate.confidence).toBeLessThanOrEqual(0.9);

    const allText =
      JSON.stringify(a) + a.estimate.summary + a.estimate.disclaimer + NEVER_GUARANTEE_NOTICE;
    expect(/\bguarantee/i.test(a.estimate.summary)).toBe(false);
    expect(a.estimate.disclaimer).toContain('not a guarantee');
    expect(allText).not.toMatch(/you will be monetized/i);
  });

  it('marks watch hours unavailable with a howToVerify when analytics are missing', () => {
    const a = assessMonetization({
      subscriberCount: 200n,
      hiddenSubscriberCount: false,
      daily: null,
      analyticsSyncedThrough: null,
    });
    const wh = a.apiData.find((d) => d.id === 'watch_hours');
    expect(wh?.status).toBe('unavailable');
    expect(wh?.howToVerify).toBeTruthy();
    expect(a.estimate.unverified).toContain('4,000 public watch hours (12 months)');
  });

  it('always includes items the API cannot provide, with verification guidance', () => {
    const a = assessMonetization({
      subscriberCount: 5000n,
      hiddenSubscriberCount: false,
      daily: dailySeries(30, 500),
      analyticsSyncedThrough: new Date(),
    });
    for (const id of ['policy_status', 'ypp_decision']) {
      const item = a.apiData.find((d) => d.id === id);
      expect(item?.status).toBe('unavailable');
      expect(item?.howToVerify).toMatch(/Studio/);
    }
  });

  it('handles a hidden subscriber count without inventing a number', () => {
    const a = assessMonetization({
      subscriberCount: null,
      hiddenSubscriberCount: true,
      daily: null,
      analyticsSyncedThrough: null,
    });
    const subs = a.apiData.find((d) => d.id === 'subs');
    expect(subs?.status).toBe('unavailable');
    expect(subs?.value).toBeUndefined();
  });
});
