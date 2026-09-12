/**
 * Lightweight (non-Postgres) coverage for `syncVideos`'s handling of a video
 * with no `create_time` (docs/DATA-ACCURACY.md). `sync.integration.test.ts`
 * exercises the same engine end-to-end but self-skips without
 * `TEST_DATABASE_URL`; this file runs the specific guard with fakes so it
 * always runs in the normal unit pass.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../integrations/health.js', () => ({ recordHealth: vi.fn(async () => {}) }));

const { syncVideos } = await import('./sync.js');

function fakeDb() {
  const upserts: Array<{ where: unknown; create: { createTime: Date } }> = [];
  const runUpdates: unknown[] = [];
  return {
    upserts,
    runUpdates,
    tikTokSyncRun: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'run_1', ...data })),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        runUpdates.push(data);
        return {};
      }),
    },
    tikTokVideo: {
      upsert: vi.fn(async (args: { where: unknown; create: { createTime: Date } }) => {
        upserts.push(args);
        return { id: `v_${upserts.length}` };
      }),
    },
    tikTokAccount: { update: vi.fn(async () => ({})) },
  };
}

const ACCOUNT = { id: 'acc_1', lastVideoCreateTime: null };
const ctx = (db: unknown) => ({
  db,
  organizationId: 'org_1',
  connection: { id: 'conn_1', status: 'ACTIVE', scopes: ['video.list'] },
});

describe('syncVideos — missing create_time guard (docs/DATA-ACCURACY.md finding)', () => {
  it('skips a video with no create_time instead of persisting a fabricated 1970-01-01 date', async () => {
    const db = fakeDb();
    const client = {
      listVideos: vi.fn(async () => ({
        data: {
          videos: [
            { id: 'v_missing' }, // no create_time at all
            { id: 'v_ok', create_time: 1_768_000_000 }, // a real, present timestamp
          ],
          has_more: false,
          cursor: undefined,
        },
        error: { code: 'ok' },
      })),
    };
    const res = await syncVideos(client as never, ctx(db) as never, ACCOUNT as never);
    // Only the video with a real create_time was persisted.
    expect(res.itemsProcessed).toBe(1);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]?.create.createTime).toEqual(new Date(1_768_000_000 * 1000));
    // The skip surfaces to the caller rather than being silently absorbed.
    expect(res.skipped).toMatch(/missing create_time/);
    // No 1970-01-01 date was ever written for the bad row.
    for (const u of db.upserts) {
      expect(u.create.createTime.getFullYear()).not.toBe(1970);
    }
  });

  it('processes every video normally when create_time is always present', async () => {
    const db = fakeDb();
    const client = {
      listVideos: vi.fn(async () => ({
        data: {
          videos: [
            { id: 'v1', create_time: 1_768_000_000 },
            { id: 'v2', create_time: 1_768_100_000 },
          ],
          has_more: false,
          cursor: undefined,
        },
        error: { code: 'ok' },
      })),
    };
    const res = await syncVideos(client as never, ctx(db) as never, ACCOUNT as never);
    expect(res.itemsProcessed).toBe(2);
    expect(res.skipped).toBeUndefined();
  });
});
