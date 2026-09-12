/**
 * Lightweight (non-Postgres) coverage for `syncAnalytics`'s handling of a
 * successful-but-incomplete Analytics API response (docs/DATA-ACCURACY.md).
 * `sync.integration.test.ts` covers the same engine end-to-end against a real
 * database but self-skips without `TEST_DATABASE_URL`; this file exercises
 * the specific guard with fakes so it always runs in the normal unit pass.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../integrations/health.js', () => ({
  addQuotaUsage: vi.fn(async () => {}),
  recordHealth: vi.fn(async () => {}),
}));
vi.mock('./quota.js', () => ({ assertQuota: vi.fn(async () => {}) }));

const { syncAnalytics } = await import('./sync.js');
const { MalformedApiDataError } = await import('./client.js');

function fakeDb() {
  const runUpdates: unknown[] = [];
  return {
    runUpdates,
    youTubeSyncRun: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'run_1', ...data })),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        runUpdates.push(data);
        return {};
      }),
    },
    youTubeMetric: { upsert: vi.fn(async () => ({})) },
    youTubeChannel: { update: vi.fn(async () => ({})) },
  };
}

const CHANNEL = { id: 'ch_1', channelId: 'UC_abc', lastAnalyticsSyncAt: null };
const ctx = (db: unknown) => ({
  db,
  organizationId: 'org_1',
  connection: { id: 'conn_1', status: 'ACTIVE', scopes: [] },
});

const ALL_COLUMNS = [
  'day',
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'likes',
  'comments',
  'shares',
  'subscribersGained',
  'subscribersLost',
];

describe('syncAnalytics — malformed-response guard (docs/DATA-ACCURACY.md finding)', () => {
  it('throws MalformedApiDataError and marks the run FAILED when a requested metric column is missing, instead of zero-filling every row', async () => {
    const db = fakeDb();
    const client = {
      queryAnalytics: vi.fn(async () => ({
        data: {
          // 'day' + 'views' only — the other 7 requested metrics are absent.
          columnHeaders: [{ name: 'day' }, { name: 'views' }],
          rows: [['2026-01-15', 100]],
        },
        quotaUnits: 1,
      })),
    };
    await expect(
      syncAnalytics(client as never, ctx(db) as never, CHANNEL as never, {
        now: new Date('2026-02-01'),
      }),
    ).rejects.toBeInstanceOf(MalformedApiDataError);
    // Nothing partial was written — not even the one column that was present.
    expect(db.youTubeMetric.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"FAILED"');
  });

  it('processes rows normally when every requested column is present', async () => {
    const db = fakeDb();
    const client = {
      queryAnalytics: vi.fn(async () => ({
        data: {
          columnHeaders: ALL_COLUMNS.map((name) => ({ name })),
          rows: [['2026-01-15', 100, 60, 30, 5, 1, 0, 2, 0]],
        },
        quotaUnits: 1,
      })),
    };
    const res = await syncAnalytics(client as never, ctx(db) as never, CHANNEL as never, {
      now: new Date('2026-02-01'),
    });
    expect(res.itemsProcessed).toBe(1);
    expect(db.youTubeMetric.upsert).toHaveBeenCalledTimes(1);
    const calls = db.youTubeMetric.upsert.mock.calls as unknown as Array<
      [{ create: { views: bigint } }]
    >;
    expect(calls[0]![0].create.views).toBe(100n);
  });

  it('still treats a missing estimatedRevenue column as legitimate (null), not malformed', async () => {
    const db = fakeDb();
    const client = {
      queryAnalytics: vi.fn(async () => ({
        data: {
          // All 8 core metrics present; estimatedRevenue was requested
          // (monetary scope granted) but absent — a non-monetized channel.
          columnHeaders: ALL_COLUMNS.map((name) => ({ name })),
          rows: [['2026-01-15', 100, 60, 30, 5, 1, 0, 2, 0]],
        },
        quotaUnits: 1,
      })),
    };
    const res = await syncAnalytics(
      client as never,
      {
        ...ctx(db),
        connection: {
          id: 'conn_1',
          status: 'ACTIVE',
          scopes: ['https://www.googleapis.com/auth/yt-analytics-monetary.readonly'],
        },
      } as never,
      CHANNEL as never,
      { now: new Date('2026-02-01') },
    );
    expect(res.itemsProcessed).toBe(1);
    const calls = db.youTubeMetric.upsert.mock.calls as unknown as Array<
      [{ create: { estimatedRevenue: number | null } }]
    >;
    expect(calls[0]![0].create.estimatedRevenue).toBeNull();
  });
});
