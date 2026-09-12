import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordUsage } from './record.js';

// Minimal in-memory stand-in for the slice of Prisma these functions touch.
function makeDb(tier: 'FREE' | 'PRO' = 'PRO') {
  const usageRecords: any[] = [];
  const counters = new Map<string, any>();
  const entitlements: any[] = [
    {
      organizationId: 'org1',
      key: 'limit:AI_TOKENS',
      limitValue: tier === 'PRO' ? 3_000_000n : 50_000n,
      boolValue: null,
      source: 'PLAN',
      expiresAt: null,
    },
    {
      organizationId: 'org1',
      key: 'limit:CRAWLS',
      limitValue: 20n,
      boolValue: null,
      source: 'PLAN',
      expiresAt: null,
    },
  ];
  const ck = (o: string, m: string, p: Date) => `${o}:${m}:${p.toISOString()}`;
  const db: any = {
    _usageRecords: usageRecords,
    _counters: counters,
    subscription: {
      findUnique: vi.fn(async () => ({ tier, currentPeriodStart: null, currentPeriodEnd: null })),
    },
    entitlement: {
      findMany: vi.fn(async ({ where }: any) =>
        entitlements.filter((e) => e.organizationId === where.organizationId),
      ),
    },
    usageRecord: {
      create: vi.fn(async ({ data }: any) => {
        if (usageRecords.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const err: any = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        usageRecords.push(data);
        return data;
      }),
    },
    usageCounter: {
      findUnique: vi.fn(async ({ where }: any) => {
        const k = ck(
          where.organizationId_meter_periodStart.organizationId,
          where.organizationId_meter_periodStart.meter,
          where.organizationId_meter_periodStart.periodStart,
        );
        return counters.get(k) ?? null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const w = where.organizationId_meter_periodStart;
        const k = ck(w.organizationId, w.meter, w.periodStart);
        const existing = counters.get(k);
        if (!existing) {
          const row = { ...create, used: BigInt(create.used) };
          counters.set(k, row);
          return row;
        }
        const inc = update.used?.increment ?? 0n;
        existing.used = BigInt(existing.used) + BigInt(inc);
        counters.set(k, existing);
        return existing;
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

const base = { organizationId: 'org1', meter: 'AI_TOKENS' as const };

describe('recordUsage', () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb();
  });

  it('appends a UsageRecord and increments the period counter', async () => {
    const r1 = await recordUsage({ ...base, quantity: 1000, idempotencyKey: 'k1' }, db as never);
    expect(r1).toMatchObject({ recorded: true, deduped: false, used: 1000 });
    const r2 = await recordUsage({ ...base, quantity: 500, idempotencyKey: 'k2' }, db as never);
    expect(r2.used).toBe(1500);
    expect(db._usageRecords).toHaveLength(2);
  });

  it('is idempotent — a repeated idempotencyKey does not double count', async () => {
    await recordUsage({ ...base, quantity: 1000, idempotencyKey: 'dupe' }, db as never);
    const again = await recordUsage(
      { ...base, quantity: 1000, idempotencyKey: 'dupe' },
      db as never,
    );
    expect(again).toMatchObject({ recorded: false, deduped: true, used: 1000 });
    expect(db._usageRecords).toHaveLength(1);
  });

  it('treats a non-positive quantity as a no-op', async () => {
    const r = await recordUsage({ ...base, quantity: 0, idempotencyKey: 'z' }, db as never);
    expect(r.recorded).toBe(false);
    expect(db._usageRecords).toHaveLength(0);
  });

  it('stamps the counter with the current plan limit', async () => {
    await recordUsage({ ...base, quantity: 10, idempotencyKey: 'k' }, db as never);
    const counter = [...db._counters.values()][0];
    expect(counter.limitValue).toBe(3_000_000n);
  });
});
