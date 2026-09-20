/**
 * Phase 23 — the over-limit matrix. Every metered resource the brief names is
 * enforced server-side by `usage.enforceUsage`; an org at or over the cap is
 * refused with `usage_limit_exceeded` (HTTP 429), an unlimited plan is never
 * refused, and a live OVERRIDE row raises the ceiling.
 */
import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { enforceUsage } from './enforce.js';
import { USAGE_METERS, type MeterKey } from './meters.js';

function makeDb(opts: {
  limits: Record<string, bigint | null>;
  counters?: Record<string, number>;
  seats?: number;
  connected?: number;
}) {
  const entitlements = Object.entries(opts.limits).map(([key, limitValue]) => ({
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
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        const meter = where.organizationId_meter_periodStart.meter;
        const used = opts.counters?.[meter];
        return used == null ? null : { used: BigInt(used) };
      }),
    },
    membership: { count: vi.fn(async () => opts.seats ?? 1) },
    oAuthConnection: { count: vi.fn(async () => opts.connected ?? 0) },
    // WordPress sites also count as connected accounts (ADR-0051).
    wordPressSite: { count: vi.fn(async () => 0) },
  } as never;
}

const isLimitError = (e: unknown) => isAppError(e) && e.code === 'usage_limit_exceeded';

// The metered resources requiring enforcement (SEATS is a gauge exercised
// elsewhere via invitations). TOOL_CALLS added Phase 5.
const REQUIRED: MeterKey[] = [
  'AI_REQUESTS',
  'AI_TOKENS',
  'CRAWLS',
  'CRAWL_PAGES',
  'CONNECTED_ACCOUNTS',
  'REPORTS',
  'CONTENT_GENERATIONS',
  'TOOL_CALLS',
];

describe('enforceUsage — over-limit is refused for every metered resource', () => {
  for (const meter of REQUIRED) {
    it(`${meter}: at the cap → usage_limit_exceeded`, async () => {
      const cap = 5;
      const db = makeDb({
        limits: { [`limit:${meter}`]: BigInt(cap) },
        counters: { [meter]: cap },
        seats: cap,
        connected: cap,
      });
      await expect(
        enforceUsage({ organizationId: 'org1', meter, amount: 1 }, db),
      ).rejects.toSatisfy(isLimitError);
    });

    it(`${meter}: under the cap → passes`, async () => {
      const db = makeDb({
        limits: { [`limit:${meter}`]: 100n },
        counters: { [meter]: 1 },
        seats: 1,
        connected: 1,
      });
      await expect(
        enforceUsage({ organizationId: 'org1', meter, amount: 1 }, db),
      ).resolves.toMatchObject({ unlimited: false });
    });
  }

  it('FREE REPORTS cap is 0 — the very first attempt is refused', async () => {
    const db = makeDb({ limits: { 'limit:REPORTS': 0n } });
    await expect(
      enforceUsage({ organizationId: 'org1', meter: 'REPORTS', amount: 1 }, db),
    ).rejects.toSatisfy(isLimitError);
  });

  it('an unlimited plan (null limit) is never refused', async () => {
    for (const meter of REQUIRED) {
      const db = makeDb({
        limits: { [`limit:${meter}`]: null },
        counters: { [meter]: 9_999_999 },
        seats: 9_999,
        connected: 9_999,
      });
      await expect(
        enforceUsage({ organizationId: 'org1', meter, amount: 1 }, db),
      ).resolves.toMatchObject({ unlimited: true });
    }
  });

  it('a live OVERRIDE raises the ceiling so a previously-blocked call passes', async () => {
    const db = makeDb({ limits: { 'limit:CRAWLS': 1_000n }, counters: { CRAWLS: 500 } });
    await expect(
      enforceUsage({ organizationId: 'org1', meter: 'CRAWLS', amount: 1 }, db),
    ).resolves.toMatchObject({ limit: 1_000, wouldExceed: false });
  });

  it('every USAGE_METERS key has a limit in every entitlement resolution path', () => {
    // Guards against a meter being added without a plan-catalog limit.
    expect(new Set(USAGE_METERS)).toEqual(
      new Set([
        'AI_REQUESTS',
        'AI_TOKENS',
        'CRAWLS',
        'CRAWL_PAGES',
        'CONNECTED_ACCOUNTS',
        'REPORTS',
        'CONTENT_GENERATIONS',
        'SEATS',
        'TOOL_CALLS',
      ]),
    );
  });
});
