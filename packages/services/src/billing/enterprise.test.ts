import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { createEnterpriseContract, expireEnterpriseContract, getActiveEnterpriseContract } from './enterprise.js';
import { resolveEntitlements, setEntitlementOverride } from './entitlements.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.user.create({ data: { id: 'user_1', email: 'a@example.com' } });
  await db.subscription.create({ data: { id: 'sub_1', organizationId: 'org_1', tier: 'PRO' } });
});

describe('enterprise contracts', () => {
  it('an active contract raises a limit and grants a feature beyond the plan default', async () => {
    await createEnterpriseContract(
      {
        organizationId: 'org_1',
        actorId: 'user_1',
        contractStart: new Date('2026-01-01'),
        customEntitlements: { 'limit:AI_REQUESTS': 500_000, 'feature:sso': true },
      },
      asDb,
    );
    const { limits, features, overridden } = await resolveEntitlements('org_1', asDb);
    expect(limits.AI_REQUESTS).toBe(500_000); // PRO's plan default is 12,000
    expect(features.sso).toBe(true); // PRO doesn't include sso by default
    expect(overridden).toContain('limit:AI_REQUESTS');
  });

  it('a per-key OVERRIDE still wins over the contract (§46 — enterprise is not unrestricted)', async () => {
    await createEnterpriseContract(
      {
        organizationId: 'org_1',
        actorId: 'user_1',
        contractStart: new Date('2026-01-01'),
        customEntitlements: { 'limit:AI_REQUESTS': 500_000 },
      },
      asDb,
    );
    await setEntitlementOverride(
      { organizationId: 'org_1', actorId: 'user_1', key: 'limit:AI_REQUESTS', limitValue: 1_000 },
      asDb,
    );
    const { limits } = await resolveEntitlements('org_1', asDb);
    expect(limits.AI_REQUESTS).toBe(1_000);
  });

  it('an expired contract (past contractEnd) no longer applies', async () => {
    await createEnterpriseContract(
      {
        organizationId: 'org_1',
        actorId: 'user_1',
        contractStart: new Date('2020-01-01'),
        contractEnd: new Date('2020-06-01'),
        customEntitlements: { 'limit:AI_REQUESTS': 500_000 },
      },
      asDb,
    );
    expect(await getActiveEnterpriseContract('org_1', asDb)).toBeNull();
    const { limits } = await resolveEntitlements('org_1', asDb);
    expect(limits.AI_REQUESTS).toBe(12_000); // back to PRO's plan default
  });

  it('cancelling a contract removes its effect', async () => {
    await createEnterpriseContract(
      {
        organizationId: 'org_1',
        actorId: 'user_1',
        contractStart: new Date('2026-01-01'),
        customEntitlements: { 'limit:AI_REQUESTS': 500_000 },
      },
      asDb,
    );
    await expireEnterpriseContract({ organizationId: 'org_1', actorId: 'user_1' }, asDb);
    expect(await getActiveEnterpriseContract('org_1', asDb)).toBeNull();
    const { limits } = await resolveEntitlements('org_1', asDb);
    expect(limits.AI_REQUESTS).toBe(12_000);
  });

  it('rejects a customEntitlements key that is not a limit:/feature: key', async () => {
    await expect(
      createEnterpriseContract(
        {
          organizationId: 'org_1',
          actorId: 'user_1',
          contractStart: new Date('2026-01-01'),
          customEntitlements: { bogus: true },
        },
        asDb,
      ),
    ).rejects.toThrow(/limit:|feature:/);
  });

  it('an org with no contract at all resolves normally (no crash, plan defaults apply)', async () => {
    const { limits } = await resolveEntitlements('org_1', asDb);
    expect(limits.AI_REQUESTS).toBe(12_000);
  });
});
