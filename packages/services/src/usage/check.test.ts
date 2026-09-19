import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { checkUsage } from './check.js';
import { enforceUsage, guardUsage } from './enforce.js';

function makeDb(
  opts: {
    limits?: Record<string, bigint | null>;
    counters?: Record<string, number>;
    seats?: number;
    connected?: number;
  } = {},
) {
  const limits = opts.limits ?? { 'limit:AI_TOKENS': 50_000n, 'limit:CONNECTED_ACCOUNTS': 1n };
  // OVERRIDE-source so the value under test actually applies (PLAN rows are
  // ignored by resolveEntitlements, which reads the catalog for those).
  const entitlements = Object.entries(limits).map(([key, limitValue]) => ({
    organizationId: 'org1',
    key,
    limitValue,
    boolValue: null,
    source: 'OVERRIDE' as const,
    expiresAt: null,
  }));
  return {
    subscription: {
      findUnique: vi.fn(async () => ({
        tier: 'FREE',
        currentPeriodStart: null,
        currentPeriodEnd: null,
      })),
    },
    entitlement: { findMany: vi.fn(async () => entitlements) },
    usageCounter: {
      findUnique: vi.fn(async ({ where }: any) => {
        const meter = where.organizationId_meter_periodStart.meter;
        const used = opts.counters?.[meter];
        return used == null ? null : { used: BigInt(used) };
      }),
    },
    membership: { count: vi.fn(async () => opts.seats ?? 1) },
    oAuthConnection: { count: vi.fn(async () => opts.connected ?? 0) },
    // WordPress sites also count as connected accounts (ADR-0051).
    wordPressSite: { count: vi.fn(async () => 0) },
  };
}

describe('checkUsage', () => {
  it('reports remaining headroom for a counter meter', async () => {
    const db = makeDb({ limits: { 'limit:AI_TOKENS': 50_000n }, counters: { AI_TOKENS: 40_000 } });
    const v = await checkUsage(
      { organizationId: 'org1', meter: 'AI_TOKENS', amount: 5_000 },
      db as never,
    );
    expect(v).toMatchObject({
      unlimited: false,
      limit: 50_000,
      used: 40_000,
      remaining: 10_000,
      wouldExceed: false,
    });
  });

  it('flags wouldExceed when the pending amount crosses the cap', async () => {
    const db = makeDb({ limits: { 'limit:AI_TOKENS': 50_000n }, counters: { AI_TOKENS: 48_000 } });
    const v = await checkUsage(
      { organizationId: 'org1', meter: 'AI_TOKENS', amount: 5_000 },
      db as never,
    );
    expect(v.wouldExceed).toBe(true);
  });

  it('treats a null limit as unlimited', async () => {
    const db = makeDb({ limits: { 'limit:AI_TOKENS': null }, counters: { AI_TOKENS: 9_000_000 } });
    const v = await checkUsage(
      { organizationId: 'org1', meter: 'AI_TOKENS', amount: 1 },
      db as never,
    );
    expect(v).toMatchObject({
      unlimited: true,
      wouldExceed: false,
      remaining: Number.POSITIVE_INFINITY,
    });
  });

  it('uses a live count for gauge meters (connected accounts)', async () => {
    const db = makeDb({ limits: { 'limit:CONNECTED_ACCOUNTS': 1n }, connected: 1 });
    const v = await checkUsage(
      { organizationId: 'org1', meter: 'CONNECTED_ACCOUNTS', amount: 1 },
      db as never,
    );
    expect(v.used).toBe(1);
    expect(v.wouldExceed).toBe(true);
    expect(db.usageCounter.findUnique).not.toHaveBeenCalled();
  });
});

describe('enforceUsage / guardUsage', () => {
  it('enforceUsage throws usage_limit_exceeded when over', async () => {
    const db = makeDb({ limits: { 'limit:CRAWLS': 2n }, counters: { CRAWLS: 2 } });
    await expect(
      enforceUsage({ organizationId: 'org1', meter: 'CRAWLS', amount: 1 }, db as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'usage_limit_exceeded');
  });

  it('enforceUsage passes when unlimited', async () => {
    const db = makeDb({ limits: { 'limit:CRAWLS': null }, counters: { CRAWLS: 999 } });
    await expect(
      enforceUsage({ organizationId: 'org1', meter: 'CRAWLS', amount: 1 }, db as never),
    ).resolves.toMatchObject({ unlimited: true });
  });

  it('guardUsage returns a boolean, never throws', async () => {
    const db = makeDb({ limits: { 'limit:CRAWLS': 2n }, counters: { CRAWLS: 2 } });
    expect(
      await guardUsage({ organizationId: 'org1', meter: 'CRAWLS', amount: 1 }, db as never),
    ).toBe(false);
  });
});
