import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { checkAiBudget, enforceAiBudget } from './ai-budget.js';

/** Fake db: OVERRIDE-source entitlement rows so the values under test apply. */
function makeDb(limits: Record<string, bigint | null>, counters: Record<string, number> = {}) {
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
      findUnique: vi.fn(async () => ({ currentPeriodStart: null, currentPeriodEnd: null })),
    },
    entitlement: { findMany: vi.fn(async () => entitlements) },
    usageCounter: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        const meter = where.organizationId_meter_periodStart.meter;
        const used = counters[meter];
        return used == null ? null : { used: BigInt(used) };
      }),
    },
    membership: { count: vi.fn(async () => 1) },
    oAuthConnection: { count: vi.fn(async () => 0) },
  } as never;
}

describe('enforceAiBudget', () => {
  it('passes when both AI meters are under the cap', async () => {
    const db = makeDb(
      { 'limit:AI_REQUESTS': 100n, 'limit:AI_TOKENS': 50_000n },
      { AI_REQUESTS: 10, AI_TOKENS: 5_000 },
    );
    await expect(enforceAiBudget({ organizationId: 'org1', db })).resolves.toBeUndefined();
  });

  it('throws (naming AI requests) when the request budget is spent', async () => {
    const db = makeDb(
      { 'limit:AI_REQUESTS': 100n, 'limit:AI_TOKENS': 50_000n },
      { AI_REQUESTS: 100, AI_TOKENS: 0 },
    );
    await expect(enforceAiBudget({ organizationId: 'org1', db })).rejects.toSatisfy(
      (e: unknown) =>
        isAppError(e) && e.code === 'usage_limit_exceeded' && /ai requests/i.test(e.message),
    );
  });

  it('throws (naming AI tokens) when the token budget is spent', async () => {
    const db = makeDb(
      { 'limit:AI_REQUESTS': 100n, 'limit:AI_TOKENS': 50_000n },
      { AI_REQUESTS: 1, AI_TOKENS: 50_000 },
    );
    await expect(enforceAiBudget({ organizationId: 'org1', db })).rejects.toSatisfy(
      (e: unknown) =>
        isAppError(e) && e.code === 'usage_limit_exceeded' && /ai tokens/i.test(e.message),
    );
  });

  it('a tokenEstimate that would cross the cap trips the gate', async () => {
    const db = makeDb(
      { 'limit:AI_REQUESTS': 100n, 'limit:AI_TOKENS': 50_000n },
      { AI_REQUESTS: 1, AI_TOKENS: 48_000 },
    );
    await expect(
      enforceAiBudget({ organizationId: 'org1', tokenEstimate: 5_000, db }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'usage_limit_exceeded');
  });

  it('never throws for an unlimited (ENTERPRISE-style) plan', async () => {
    const db = makeDb(
      { 'limit:AI_REQUESTS': null, 'limit:AI_TOKENS': null },
      { AI_REQUESTS: 9_999, AI_TOKENS: 9_999_999 },
    );
    await expect(enforceAiBudget({ organizationId: 'org1', db })).resolves.toBeUndefined();
  });
});

describe('checkAiBudget', () => {
  it('reports which meter is over without throwing', async () => {
    const db = makeDb(
      { 'limit:AI_REQUESTS': 100n, 'limit:AI_TOKENS': 50_000n },
      { AI_REQUESTS: 1, AI_TOKENS: 50_000 },
    );
    const res = await checkAiBudget({ organizationId: 'org1', db });
    expect(res.ok).toBe(false);
    expect(res.meter).toBe('AI_TOKENS');
  });

  it('returns ok when both are under', async () => {
    const db = makeDb({ 'limit:AI_REQUESTS': 100n, 'limit:AI_TOKENS': 50_000n });
    expect(await checkAiBudget({ organizationId: 'org1', db })).toEqual({ ok: true });
  });
});
