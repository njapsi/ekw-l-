import { describe, expect, it, vi } from 'vitest';
import { USAGE_METERS } from './meters.js';
import { getUsageSummary, refreshUsageCounters } from './summary.js';

function makeDb(
  opts: {
    counters?: Record<string, number>;
    records?: Array<{ meter: string; quantity: bigint }>;
    seats?: number;
    connected?: number;
  } = {},
) {
  const counterRows = Object.entries(opts.counters ?? {}).map(([meter, used]) => ({
    meter,
    used: BigInt(used),
    periodStart: new Date('2026-09-01T00:00:00Z'),
  }));
  const upserts: any[] = [];
  return {
    _upserts: upserts,
    subscription: {
      findUnique: vi.fn(async () => ({
        tier: 'CREATOR',
        currentPeriodStart: null,
        currentPeriodEnd: null,
      })),
    },
    entitlement: {
      findMany: vi.fn(async () => [
        {
          organizationId: 'org1',
          key: 'limit:AI_TOKENS',
          limitValue: 500_000n,
          boolValue: null,
          source: 'PLAN',
          expiresAt: null,
        },
        {
          organizationId: 'org1',
          key: 'limit:CRAWL_PAGES',
          limitValue: 5_000n,
          boolValue: null,
          source: 'PLAN',
          expiresAt: null,
        },
        {
          organizationId: 'org1',
          key: 'limit:CONNECTED_ACCOUNTS',
          limitValue: 3n,
          boolValue: null,
          source: 'PLAN',
          expiresAt: null,
        },
      ]),
    },
    usageCounter: {
      findMany: vi.fn(async () => counterRows),
      upsert: vi.fn(async (arg: any) => {
        upserts.push(arg);
        return {};
      }),
    },
    usageRecord: {
      aggregate: vi.fn(async ({ where }: any) => {
        const total = (opts.records ?? [])
          .filter((r) => r.meter === where.meter)
          .reduce((s, r) => s + r.quantity, 0n);
        return { _sum: { quantity: total || null } };
      }),
    },
    membership: { count: vi.fn(async () => opts.seats ?? 2) },
    oAuthConnection: { count: vi.fn(async () => opts.connected ?? 1) },
    // WordPress sites also count as connected accounts (ADR-0051).
    wordPressSite: { count: vi.fn(async () => 0) },
  };
}

describe('getUsageSummary', () => {
  it('returns one entry per meter with a state derived from the ratio', async () => {
    const db = makeDb({ counters: { AI_TOKENS: 450_000, CRAWL_PAGES: 6_000 } });
    const s = await getUsageSummary('org1', db as never);
    const byMeter = Object.fromEntries(s.meters.map((m) => [m.meter, m]));
    expect(byMeter.AI_TOKENS).toMatchObject({ used: 450_000, limit: 500_000, state: 'warn' });
    expect(byMeter.CRAWL_PAGES).toMatchObject({ used: 6_000, state: 'over' });
    expect(byMeter.REPORTS).toMatchObject({ used: 0 });
  });

  it('reports gauges (seats, connected accounts) from a live count, not a counter', async () => {
    const db = makeDb({ seats: 2, connected: 3 });
    const s = await getUsageSummary('org1', db as never);
    const seats = s.meters.find((m) => m.meter === 'SEATS')!;
    const conn = s.meters.find((m) => m.meter === 'CONNECTED_ACCOUNTS')!;
    expect(seats.used).toBe(2);
    expect(conn).toMatchObject({ used: 3, limit: 3, state: 'over' });
  });
});

describe('refreshUsageCounters (self-healing rollup)', () => {
  it('rebuilds every meter counter from the UsageRecord ledger', async () => {
    const db = makeDb({
      records: [
        { meter: 'AI_TOKENS', quantity: 1_000n },
        { meter: 'AI_TOKENS', quantity: 2_500n },
        { meter: 'CRAWLS', quantity: 3n },
      ],
    });
    await refreshUsageCounters('org1', db as never);
    // one upsert per meter
    expect(db._upserts.length).toBe(USAGE_METERS.length);
    const ai = db._upserts.find(
      (u: any) => u.where.organizationId_meter_periodStart.meter === 'AI_TOKENS',
    );
    expect(ai.create.used).toBe(3_500n);
  });
});
