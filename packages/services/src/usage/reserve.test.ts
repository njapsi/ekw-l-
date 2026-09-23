import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

const { reserveUsage, releaseUsageReservation } = await import('./reserve.js');
const { UsageLimitError } = await import('./enforce.js');

let db: MemoryDb;
let asDb: Db;

async function seedOrg(limit: number | null) {
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.subscription.create({ data: { id: 'sub_1', organizationId: 'org_1', tier: 'CREATOR' } });
  await db.entitlement.create({
    data: {
      organizationId: 'org_1',
      key: 'limit:CONTENT_GENERATIONS',
      limitValue: limit == null ? null : BigInt(limit),
      source: 'OVERRIDE',
    },
  });
}

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

describe('reserveUsage', () => {
  it('reserves under the limit and increments the counter atomically', async () => {
    await seedOrg(10);
    const r = await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 3, idempotencyKey: 'k1' },
      asDb,
    );
    expect(r).toMatchObject({ ok: true, deduped: false, used: 3, limit: 10 });
    expect(db.usageRecord.rows).toHaveLength(1);
  });

  it('rejects a reservation that would exceed the limit, leaving no trace', async () => {
    await seedOrg(5);
    await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 4, idempotencyKey: 'k1' },
      asDb,
    );
    await expect(
      reserveUsage(
        { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 2, idempotencyKey: 'k2' },
        asDb,
      ),
    ).rejects.toThrow(UsageLimitError);

    // The rejected attempt's UsageRecord must never have been written — the
    // rollback (memory-db's new $transaction snapshot/restore) undoes it.
    expect(db.usageRecord.rows).toHaveLength(1);
    const counter = db.usageCounter.rows[0] as { used: bigint };
    expect(Number(counter.used)).toBe(4);
  });

  it('a retried reservation (same idempotencyKey) is deduped, never double-counted', async () => {
    await seedOrg(10);
    const first = await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 3, idempotencyKey: 'retry-1' },
      asDb,
    );
    const second = await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 3, idempotencyKey: 'retry-1' },
      asDb,
    );
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.used).toBe(3);
    expect(db.usageRecord.rows).toHaveLength(1);
  });

  it('an unlimited meter always succeeds and still records for audit', async () => {
    await seedOrg(null);
    const r = await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 100, idempotencyKey: 'k1' },
      asDb,
    );
    expect(r).toMatchObject({ ok: true, unlimited: true });
    expect(db.usageRecord.rows).toHaveLength(1);
  });

  it(
    "the brief's own acceptance test: 10 concurrent reservations against 5 remaining capacity — " +
      'exactly 5 succeed, 5 are rejected, the counter never exceeds the limit (Phase 13 §56/§99/§110)',
    async () => {
      await seedOrg(5);
      const attempts = Array.from({ length: 10 }, (_, i) =>
        reserveUsage(
          { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 1, idempotencyKey: `c${i}` },
          asDb,
        ).then(
          () => ({ ok: true as const }),
          () => ({ ok: false as const }),
        ),
      );
      const results = await Promise.all(attempts);
      const succeeded = results.filter((r) => r.ok).length;
      const rejected = results.filter((r) => !r.ok).length;

      expect(succeeded).toBe(5);
      expect(rejected).toBe(5);
      const counter = db.usageCounter.rows[0] as { used: bigint };
      expect(Number(counter.used)).toBe(5); // never overshoots, never undershoots
      expect(db.usageRecord.rows).toHaveLength(5); // exactly one durable record per success
    },
  );

  it('a single request larger than the entire remaining limit is rejected outright', async () => {
    await seedOrg(5);
    await expect(
      reserveUsage(
        { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 10, idempotencyKey: 'k1' },
        asDb,
      ),
    ).rejects.toThrow(UsageLimitError);
    expect(db.usageRecord.rows).toHaveLength(0);
  });
});

describe('releaseUsageReservation', () => {
  it('gives back the unused delta as a negative, append-only adjustment record', async () => {
    await seedOrg(10);
    await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 5, idempotencyKey: 'job-1' },
      asDb,
    );
    // Only 2 of the 5 reserved deliverables actually completed.
    await releaseUsageReservation(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', quantity: 3, idempotencyKey: 'job-1' },
      asDb,
    );
    const counter = db.usageCounter.rows[0] as { used: bigint };
    expect(Number(counter.used)).toBe(2);
    expect(db.usageRecord.rows).toHaveLength(2); // original reservation + the release adjustment
    const release = db.usageRecord.rows.find((r) => (r.metadata as { release?: boolean } | null)?.release);
    expect(Number(release?.quantity)).toBe(-3);
  });

  it('is idempotent — releasing the same reservation twice only adjusts once', async () => {
    await seedOrg(10);
    await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 5, idempotencyKey: 'job-2' },
      asDb,
    );
    await releaseUsageReservation(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', quantity: 3, idempotencyKey: 'job-2' },
      asDb,
    );
    await releaseUsageReservation(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', quantity: 3, idempotencyKey: 'job-2' },
      asDb,
    );
    const counter = db.usageCounter.rows[0] as { used: bigint };
    expect(Number(counter.used)).toBe(2);
  });

  it('releasing a full reservation (total job failure) returns all of it', async () => {
    await seedOrg(10);
    await reserveUsage(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', amount: 4, idempotencyKey: 'job-3' },
      asDb,
    );
    await releaseUsageReservation(
      { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', quantity: 4, idempotencyKey: 'job-3' },
      asDb,
    );
    const counter = db.usageCounter.rows[0] as { used: bigint };
    expect(Number(counter.used)).toBe(0);
  });

  it('releasing against a key that was never reserved is a safe no-op', async () => {
    await seedOrg(10);
    await expect(
      releaseUsageReservation(
        { organizationId: 'org_1', meter: 'CONTENT_GENERATIONS', quantity: 3, idempotencyKey: 'never-reserved' },
        asDb,
      ),
    ).resolves.toBeUndefined();
  });
});
