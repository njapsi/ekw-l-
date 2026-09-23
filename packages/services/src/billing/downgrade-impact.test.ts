import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { getDowngradeImpact } from './downgrade-impact.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.subscription.create({ data: { id: 'sub_1', organizationId: 'org_1', tier: 'PRO' } });
});

describe('getDowngradeImpact', () => {
  it('flags a meter whose current usage already exceeds the target plan (no blocking impact when under)', async () => {
    // PRO → CREATOR: CONTENT_GENERATIONS drops from 1,000 to 150.
    await db.usageCounter.create({
      data: {
        organizationId: 'org_1',
        meter: 'CONTENT_GENERATIONS',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-10-01'),
        used: BigInt(200),
        limitValue: BigInt(1_000),
      },
    });
    const impact = await getDowngradeImpact('org_1', 'CREATOR', asDb);
    const cg = impact.meterImpacts.find((m) => m.meter === 'CONTENT_GENERATIONS');
    expect(cg?.wouldExceedImmediately).toBe(true);
    expect(cg?.currentUsage).toBe(200);
    expect(cg?.newLimit).toBe(150);
    expect(impact.hasBlockingImpact).toBe(true);
  });

  it('reports lost features on a downgrade (PRO has automationMode; CREATOR does not)', async () => {
    const impact = await getDowngradeImpact('org_1', 'CREATOR', asDb);
    expect(impact.featuresLost).toContain('automationMode');
  });

  it('reports a changed limit without flagging it as blocking when current usage is comfortably under it', async () => {
    await db.usageCounter.create({
      data: {
        organizationId: 'org_1',
        meter: 'CONTENT_GENERATIONS',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-10-01'),
        used: BigInt(5),
        limitValue: BigInt(1_000),
      },
    });
    // CREATOR still allows 150 content generations — 5 used is well under,
    // so it shows up (the cap is changing) but isn't a blocking impact.
    const impact = await getDowngradeImpact('org_1', 'CREATOR', asDb);
    const cg = impact.meterImpacts.find((m) => m.meter === 'CONTENT_GENERATIONS');
    expect(cg?.newLimit).toBe(150);
    expect(cg?.wouldExceedImmediately).toBe(false);
  });

  it('never deletes or touches any usage/content row — read-only', async () => {
    await db.usageCounter.create({
      data: {
        organizationId: 'org_1',
        meter: 'CONTENT_GENERATIONS',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-10-01'),
        used: BigInt(500),
        limitValue: BigInt(1_000),
      },
    });
    await getDowngradeImpact('org_1', 'FREE', asDb);
    expect(db.usageCounter.rows).toHaveLength(1);
    expect(Number(db.usageCounter.rows[0]?.used)).toBe(500); // unchanged
  });
});
