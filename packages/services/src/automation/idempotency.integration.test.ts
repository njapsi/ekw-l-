import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimRun } from './runner.js';

/**
 * Duplicate / concurrent automation execution against a real database
 * (Phase 15 QA). Self-skips without a DB — runs in CI.
 *
 * The guarantee: `AutomationRun @@unique([automationRuleId, scheduledFor])` means
 * a tick can be executed at most once, even under a race between two sweeps or
 * two workers. `claimRun` turns the resulting Prisma `P2002` into
 * `{ claimed: false }`.
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
let reachable = false;

const tag = `autoidem_${Date.now()}`;
let orgId = '';
let ruleId = '';

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    return;
  }
  const user = await prisma.user.create({ data: { email: `${tag}@example.com` } });
  const org = await prisma.organization.create({
    data: {
      name: tag,
      slug: tag,
      memberships: { create: { userId: user.id, role: 'OWNER', status: 'ACTIVE' } },
    },
  });
  orgId = org.id;
  const rule = await prisma.automationRule.create({
    data: {
      organizationId: org.id,
      ownerId: user.id,
      createdById: user.id,
      taskType: 'GROWTH_REPORT',
      name: 'idempotency rule',
      cadence: 'WEEKLY',
      cronExpression: '0 9 * * 1',
    },
  });
  ruleId = rule.id;
});

afterAll(async () => {
  if (prisma && reachable && orgId) {
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { email: `${tag}@example.com` } });
  }
  await prisma?.$disconnect();
});

const maybe = () => (reachable ? it : it.skip);

describe('automation tick idempotency (integration)', () => {
  it('self-skips without a database', () => {
    expect(true).toBe(true);
  });

  maybe()('a second claim for the same tick is refused by the unique constraint', async () => {
    const scheduledFor = new Date('2027-01-04T09:00:00Z');
    const a = await claimRun({ ruleId, organizationId: orgId, scheduledFor }, prisma!);
    const b = await claimRun({ ruleId, organizationId: orgId, scheduledFor }, prisma!);
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(false);
    expect(b.runId).toBe(a.runId); // resolves to the row that won
  });

  maybe()('two concurrent claims for the same tick → exactly one wins', async () => {
    const scheduledFor = new Date('2027-01-11T09:00:00Z');
    const results = await Promise.all([
      claimRun({ ruleId, organizationId: orgId, scheduledFor }, prisma!),
      claimRun({ ruleId, organizationId: orgId, scheduledFor }, prisma!),
      claimRun({ ruleId, organizationId: orgId, scheduledFor }, prisma!),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const rows = await prisma!.automationRun.count({
      where: { automationRuleId: ruleId, scheduledFor },
    });
    expect(rows).toBe(1);
  });
});
