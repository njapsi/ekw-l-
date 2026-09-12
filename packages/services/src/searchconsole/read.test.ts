import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { isAppError } from '../errors.js';
import { FixturesSearchConsoleClient } from './fixtures-client.js';

vi.mock('../integrations/health.js', () => ({
  addQuotaUsage: vi.fn(async () => {}),
  recordHealth: vi.fn(async () => {}),
}));
vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const { refreshPerformance, getDashboard } = await import('./read.js');

const SITE = {
  id: 'site_1',
  organizationId: 'org_1',
  oauthConnectionId: 'conn_1',
  siteUrl: 'sc-domain:example.com',
  isSelected: true,
};

function fakeDb(over: Partial<Record<string, unknown>> = {}) {
  const snapshots: Array<Record<string, unknown>> = [];
  const db = {
    searchConsoleSite: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.isSelected) return 'selected' in over ? (over.selected ?? null) : SITE;
        if (where.id && where.id === SITE.id) return SITE;
        return null;
      }),
      update: vi.fn(async () => SITE),
    },
    searchConsoleSnapshot: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `snap_${snapshots.length + 1}`, capturedAt: new Date(), ...data };
        snapshots.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          snapshots
            .filter((s) => s.kind === where.kind)
            .sort(
              (a, b) => (b.capturedAt as Date).getTime() - (a.capturedAt as Date).getTime(),
            )[0] ?? null,
      ),
      findMany: vi.fn(async () => []),
    },
    oAuthConnection: { findFirst: vi.fn(async () => null) },
    ...over,
  };
  return { db: db as unknown as Db, snapshots };
}

const fixture = (
  over: Partial<ConstructorParameters<typeof FixturesSearchConsoleClient>[0]> = {},
) =>
  new FixturesSearchConsoleClient({
    sites: [{ siteUrl: SITE.siteUrl, permissionLevel: 'siteOwner' }],
    analytics: {
      date: [{ keys: ['2026-09-01'], clicks: 10, impressions: 200, ctr: 0.05, position: 7 }],
      query: [{ keys: ['growth'], clicks: 8, impressions: 150, ctr: 0.053, position: 6 }],
      page: [
        { keys: ['https://example.com/a'], clicks: 8, impressions: 150, ctr: 0.053, position: 6 },
      ],
      country: [{ keys: ['usa'], clicks: 10, impressions: 200, ctr: 0.05, position: 7 }],
      device: [{ keys: ['DESKTOP'], clicks: 10, impressions: 200, ctr: 0.05, position: 7 }],
      // searchAppearance intentionally empty
    },
    ...over,
  });

beforeEach(() => vi.clearAllMocks());

describe('refreshPerformance', () => {
  it('writes a PERFORMANCE snapshot with all six dimensions + totals, tolerating empty searchAppearance', async () => {
    const { db, snapshots } = fakeDb();
    await refreshPerformance({
      organizationId: 'org_1',
      userId: 'user_1',
      redirectUri: 'https://app/cb',
      client: fixture(),
      db,
    });
    expect(snapshots).toHaveLength(1);
    const data = snapshots[0]!.data as Record<string, unknown[]> & {
      totals: Record<string, number>;
    };
    expect(data.byDate).toHaveLength(1);
    expect(data.byQuery).toHaveLength(1);
    expect(data.bySearchAppearance).toEqual([]);
    expect(data.totals.impressions).toBe(200);
    expect(data.totals.clicks).toBe(10);
    // A single day: ctr = 10/200 = 0.05; impression-weighted position = (7*200)/200 = 7.
    expect(data.totals.ctr).toBe(0.05);
    expect(data.totals.position).toBe(7);
  });

  it('reports totals.ctr/position as null (not 0) when the window has zero impressions', async () => {
    const { db, snapshots } = fakeDb();
    await refreshPerformance({
      organizationId: 'org_1',
      userId: 'user_1',
      redirectUri: 'https://app/cb',
      client: fixture({
        analytics: {
          date: [{ keys: ['2026-09-01'], clicks: 0, impressions: 0, ctr: 0, position: 0 }],
          query: [],
          page: [],
          country: [],
          device: [],
        },
      }),
      db,
    });
    const data = snapshots[0]!.data as Record<string, unknown[]> & {
      totals: Record<string, number | null>;
    };
    expect(data.totals.impressions).toBe(0);
    // Google never reports a real position of 0 — null means "nothing to
    // average," never a measured zero.
    expect(data.totals.ctr).toBeNull();
    expect(data.totals.position).toBeNull();
  });

  it('throws when no property is selected', async () => {
    const { db } = fakeDb({ selected: null });
    await expect(
      refreshPerformance({
        organizationId: 'org_1',
        userId: 'u',
        redirectUri: 'r',
        client: fixture(),
        db,
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'resource_not_found');
  });

  it('surfaces an API failure and writes no snapshot', async () => {
    const { db, snapshots } = fakeDb();
    await expect(
      refreshPerformance({
        organizationId: 'org_1',
        userId: 'u',
        redirectUri: 'r',
        client: fixture({ faults: new Set(['quota-exceeded']) }),
        db,
      }),
    ).rejects.toThrow();
    expect(snapshots).toHaveLength(0);
  });
});

describe('getDashboard', () => {
  it('returns { connection: null } cleanly when nothing is connected', async () => {
    const { db } = fakeDb();
    const res = await getDashboard('org_1', db);
    expect(res).toEqual({ connection: null, property: null });
  });
});
