import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { adjustCredits, consumeCredits, getCreditBalance, grantCredits, listCreditTransactions } from './credits.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.user.create({ data: { id: 'user_1', email: 'a@example.com' } });
});

describe('credit ledger', () => {
  it('starts at zero and grants add to the balance, each as its own row with a balanceAfter snapshot', async () => {
    expect(await getCreditBalance('org_1', 'AI_REQUESTS', asDb)).toBe(0);
    await grantCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 100, actorId: 'user_1' }, asDb);
    expect(await getCreditBalance('org_1', 'AI_REQUESTS', asDb)).toBe(100);
    await grantCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 50, actorId: 'user_1' }, asDb);
    expect(await getCreditBalance('org_1', 'AI_REQUESTS', asDb)).toBe(150);
    const rows = await listCreditTransactions('org_1', 'AI_REQUESTS', asDb);
    expect(rows.map((r) => r.balanceAfter)).toEqual([150, 100]); // newest first
  });

  it('consuming credits decrements the balance and records a negative-amount row', async () => {
    await grantCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 100, actorId: 'user_1' }, asDb);
    const row = await consumeCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 30 }, asDb);
    expect(row?.amount).toBe(-30);
    expect(row?.balanceAfter).toBe(70);
    expect(await getCreditBalance('org_1', 'AI_REQUESTS', asDb)).toBe(70);
  });

  it('refuses to consume more than the available balance — never goes negative', async () => {
    await grantCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 10, actorId: 'user_1' }, asDb);
    await expect(
      consumeCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 11 }, asDb),
    ).rejects.toThrow(/insufficient/i);
    expect(await getCreditBalance('org_1', 'AI_REQUESTS', asDb)).toBe(10);
  });

  it('a meter with no credits ever granted has a zero balance, not an error', async () => {
    expect(await getCreditBalance('org_1', 'CONTENT_GENERATIONS', asDb)).toBe(0);
  });

  it('adjustCredits requires a reason and is audited', async () => {
    await expect(
      adjustCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 20, actorId: 'user_1', reason: '' }, asDb),
    ).rejects.toThrow(/reason/i);
    await adjustCredits(
      { organizationId: 'org_1', meter: 'AI_REQUESTS', amount: -5, actorId: 'user_1', reason: 'correcting a double grant' },
      asDb,
    );
    expect(await getCreditBalance('org_1', 'AI_REQUESTS', asDb)).toBe(-5);
    const audit = db.auditLog.rows.filter((r) => r.action === 'billing.credit.adjusted');
    expect(audit).toHaveLength(1);
  });

  it('grantCredits rejects a non-positive amount', async () => {
    await expect(
      grantCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 0, actorId: 'user_1' }, asDb),
    ).rejects.toThrow(/positive/i);
  });

  it('credit balances are tracked independently per meter', async () => {
    await grantCredits({ organizationId: 'org_1', meter: 'AI_REQUESTS', amount: 100, actorId: 'user_1' }, asDb);
    await grantCredits({ organizationId: 'org_1', meter: 'RESEARCH_CALLS', amount: 5, actorId: 'user_1' }, asDb);
    expect(await getCreditBalance('org_1', 'AI_REQUESTS', asDb)).toBe(100);
    expect(await getCreditBalance('org_1', 'RESEARCH_CALLS', asDb)).toBe(5);
  });
});
