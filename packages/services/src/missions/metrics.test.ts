import { describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { allSuccessMetricsMet, computeTrend, getMissionMetricProgress, recordMissionMetric } from './metrics.js';

describe('computeTrend', () => {
  it('is null when either point is missing (not enough data yet)', () => {
    expect(computeTrend(null, 10)).toBeNull();
    expect(computeTrend(10, null)).toBeNull();
  });

  it('detects a clear increase', () => {
    expect(computeTrend(100, 150)).toBe('up');
  });

  it('detects a clear decrease', () => {
    expect(computeTrend(100, 50)).toBe('down');
  });

  it('reads a small relative move as flat, not noise-as-trend', () => {
    expect(computeTrend(100, 101)).toBe('flat');
  });

  it('handles a zero baseline without dividing by zero', () => {
    expect(computeTrend(0, 0)).toBe('flat');
    expect(computeTrend(0, 5)).toBe('up');
    expect(computeTrend(0, -5)).toBe('down');
  });
});

describe('recordMissionMetric + getMissionMetricProgress', () => {
  let db: MemoryDb;
  let asDb: Db;

  function setup() {
    db = createMemoryDb();
    asDb = db as unknown as Db;
  }

  it('the first measurement has no previous value and no trend', async () => {
    setup();
    await recordMissionMetric(
      { organizationId: 'org_1', missionId: 'm1', key: 'clicks', label: 'Clicks', kind: 'LAGGING', currentValue: 100, source: 'search_console' },
      asDb,
    );
    const progress = await getMissionMetricProgress('org_1', 'm1', asDb);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ current: 100, previous: null, trend: null });
  });

  it('a second measurement computes trend against the first', async () => {
    setup();
    await recordMissionMetric(
      { organizationId: 'org_1', missionId: 'm1', key: 'clicks', label: 'Clicks', kind: 'LAGGING', currentValue: 100, source: 'search_console' },
      asDb,
    );
    // A real, if small, elapsed gap: two measurements recorded in the exact
    // same millisecond have no meaningfully defined "most recent" without an
    // explicit sequence field this schema doesn't have (by design — real
    // metric syncs are always minutes to hours apart in practice).
    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordMissionMetric(
      { organizationId: 'org_1', missionId: 'm1', key: 'clicks', label: 'Clicks', kind: 'LAGGING', currentValue: 200, source: 'search_console' },
      asDb,
    );
    const progress = await getMissionMetricProgress('org_1', 'm1', asDb);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ current: 200, previous: 100, trend: 'up' });
  });

  it('progressToTarget is null without a target, and a real fraction with one', async () => {
    setup();
    await recordMissionMetric(
      { organizationId: 'org_1', missionId: 'm1', key: 'clicks', label: 'Clicks', kind: 'LAGGING', currentValue: 40, targetValue: 100, source: 'search_console' },
      asDb,
    );
    const progress = await getMissionMetricProgress('org_1', 'm1', asDb);
    expect(progress[0]?.progressToTarget).toBeCloseTo(0.4);
  });
});

describe('allSuccessMetricsMet', () => {
  let db: MemoryDb;
  let asDb: Db;
  function setup() {
    db = createMemoryDb();
    asDb = db as unknown as Db;
  }

  it('is false when no success metric defines a target (nothing to compare against)', async () => {
    setup();
    const met = await allSuccessMetricsMet('org_1', 'm1', [{ key: 'clicks', label: 'Clicks', kind: 'LAGGING' }], asDb);
    expect(met).toBe(false);
  });

  it('is false while a targeted metric has not been measured at all', async () => {
    setup();
    const met = await allSuccessMetricsMet(
      'org_1',
      'm1',
      [{ key: 'clicks', label: 'Clicks', kind: 'LAGGING', targetValue: 100 }],
      asDb,
    );
    expect(met).toBe(false);
  });

  it('is false while below target, true once at or above it', async () => {
    setup();
    await recordMissionMetric({ organizationId: 'org_1', missionId: 'm1', key: 'clicks', label: 'Clicks', kind: 'LAGGING', currentValue: 90, source: 'manual' }, asDb);
    let met = await allSuccessMetricsMet('org_1', 'm1', [{ key: 'clicks', label: 'Clicks', kind: 'LAGGING', targetValue: 100 }], asDb);
    expect(met).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordMissionMetric({ organizationId: 'org_1', missionId: 'm1', key: 'clicks', label: 'Clicks', kind: 'LAGGING', currentValue: 100, source: 'manual' }, asDb);
    met = await allSuccessMetricsMet('org_1', 'm1', [{ key: 'clicks', label: 'Clicks', kind: 'LAGGING', targetValue: 100 }], asDb);
    expect(met).toBe(true);
  });

  it('requires every targeted metric to be met, not just one of several', async () => {
    setup();
    await recordMissionMetric({ organizationId: 'org_1', missionId: 'm1', key: 'clicks', label: 'Clicks', kind: 'LAGGING', currentValue: 100, source: 'manual' }, asDb);
    await recordMissionMetric({ organizationId: 'org_1', missionId: 'm1', key: 'leads', label: 'Leads', kind: 'LAGGING', currentValue: 1, source: 'manual' }, asDb);
    const met = await allSuccessMetricsMet(
      'org_1',
      'm1',
      [
        { key: 'clicks', label: 'Clicks', kind: 'LAGGING', targetValue: 100 },
        { key: 'leads', label: 'Leads', kind: 'LAGGING', targetValue: 10 },
      ],
      asDb,
    );
    expect(met).toBe(false);
  });
});
