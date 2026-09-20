import { describe, expect, it, vi } from 'vitest';
import { USAGE_METERS } from '../usage/meters.js';
import { getPlan } from './plans.js';
import { resolveEntitlements, syncPlanEntitlements } from './entitlements.js';

function makeDb(seed: { tier?: string; rows?: any[] } = {}) {
  const rows: any[] = seed.rows ? [...seed.rows] : [];
  const db: any = {
    _rows: rows,
    subscription: {
      findUnique: vi.fn(async () => ({ tier: seed.tier ?? 'FREE' })),
    },
    entitlement: {
      findMany: vi.fn(async ({ where }: any) =>
        rows.filter((r) => r.organizationId === where.organizationId),
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const idx = rows.findIndex(
          (r) =>
            r.organizationId === where.organizationId_key.organizationId &&
            r.key === where.organizationId_key.key,
        );
        if (idx === -1) {
          const row = { id: `e${rows.length}`, expiresAt: null, ...create };
          rows.push(row);
          return row;
        }
        rows[idx] = { ...rows[idx], ...update };
        return rows[idx];
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

describe('syncPlanEntitlements', () => {
  it('materialises one PLAN row per meter + per feature from the catalog', async () => {
    const db = makeDb();
    await syncPlanEntitlements('org1', 'PRO', db as never);
    const limitRows = db._rows.filter((r: any) => r.key.startsWith('limit:'));
    const featureRows = db._rows.filter((r: any) => r.key.startsWith('feature:'));
    expect(limitRows).toHaveLength(USAGE_METERS.length);
    expect(featureRows.length).toBeGreaterThanOrEqual(7);
    const aiTokens = db._rows.find((r: any) => r.key === 'limit:AI_TOKENS');
    expect(aiTokens.limitValue).toBe(BigInt(getPlan('PRO').limits.AI_TOKENS!));
    expect(aiTokens.source).toBe('PLAN');
  });

  it('is idempotent — re-running for the same tier keeps one row per key', async () => {
    const db = makeDb();
    await syncPlanEntitlements('org1', 'CREATOR', db as never);
    const count = db._rows.length;
    await syncPlanEntitlements('org1', 'CREATOR', db as never);
    expect(db._rows.length).toBe(count);
  });
});

describe('resolveEntitlements', () => {
  it('returns catalog defaults for the current tier', async () => {
    const db = makeDb({ tier: 'CREATOR' });
    const res = await resolveEntitlements('org1', db as never);
    expect(res.tier).toBe('CREATOR');
    expect(res.limits.AI_TOKENS).toBe(getPlan('CREATOR').limits.AI_TOKENS);
    expect(res.features.exports).toBe(true);
  });

  it('an OVERRIDE row wins over the plan default', async () => {
    const db = makeDb({
      tier: 'FREE',
      rows: [
        {
          organizationId: 'org1',
          key: 'limit:AI_TOKENS',
          limitValue: 999_999n,
          boolValue: null,
          source: 'OVERRIDE',
          expiresAt: null,
        },
        {
          organizationId: 'org1',
          key: 'feature:exports',
          limitValue: null,
          boolValue: true,
          source: 'PROMO',
          expiresAt: null,
        },
      ],
    });
    const res = await resolveEntitlements('org1', db as never);
    expect(res.limits.AI_TOKENS).toBe(999_999);
    expect(res.features.exports).toBe(true);
    expect(res.overridden).toEqual(expect.arrayContaining(['limit:AI_TOKENS', 'feature:exports']));
  });

  it('ignores an expired override', async () => {
    const db = makeDb({
      tier: 'FREE',
      rows: [
        {
          organizationId: 'org1',
          key: 'limit:AI_TOKENS',
          limitValue: 999_999n,
          boolValue: null,
          source: 'OVERRIDE',
          expiresAt: new Date('2000-01-01'),
        },
      ],
    });
    const res = await resolveEntitlements('org1', db as never, new Date('2026-01-01'));
    expect(res.limits.AI_TOKENS).toBe(getPlan('FREE').limits.AI_TOKENS);
  });
});
