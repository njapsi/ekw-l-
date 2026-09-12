import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  setAutomationStatus,
  updateAutomation,
} from './rules.js';

interface FakeOpts {
  role?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  membershipStatus?: 'ACTIVE' | 'SUSPENDED';
  noMembership?: boolean;
}

function makeDb(opts: FakeOpts = {}) {
  const rules: any[] = [];
  const runs: any[] = [];
  const audits: any[] = [];
  let seq = 0;

  const db: any = {
    _rules: rules,
    _audits: audits,
    membership: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (opts.noMembership) return null;
        return {
          userId: where.userId_organizationId.userId,
          organizationId: where.userId_organizationId.organizationId,
          role: opts.role ?? 'MEMBER',
          status: opts.membershipStatus ?? 'ACTIVE',
        };
      }),
    },
    automationRule: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `rule_${++seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastRunAt: null,
          lastRunStatus: null,
          failureCount: 0,
          totalRuns: 0,
          lastError: null,
          ...data,
        };
        rules.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rules.find((r) => r.id === where.id && r.organizationId === where.organizationId) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) => {
        const rows = rules.filter((r) => r.organizationId === where.organizationId);
        return rows.map((r) => ({ ...r, runs: runs.filter((x) => x.automationRuleId === r.id) }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rules.find((r) => r.id === where.id);
        for (const [k, v] of Object.entries(data)) {
          row[k] =
            v && typeof v === 'object' && 'increment' in (v as object)
              ? (row[k] ?? 0) + (v as { increment: number }).increment
              : v;
        }
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const i = rules.findIndex((r) => r.id === where.id);
        if (i >= 0) rules.splice(i, 1);
      }),
    },
    automationRun: {
      findMany: vi.fn(async ({ where }: any) =>
        runs.filter((r) => r.automationRuleId === where.automationRuleId),
      ),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => void audits.push(data)) },
  };
  return db;
}

const base = { organizationId: 'org1', userId: 'u1' };

describe('createAutomation', () => {
  it('computes the cron + nextRunAt for a weekly cadence and audits it', async () => {
    const db = makeDb({ role: 'MEMBER' });
    const rule = await createAutomation(
      {
        ...base,
        name: 'YT Monday',
        taskType: 'YOUTUBE_ANALYSIS',
        cadence: 'WEEKLY',
        weekday: 1,
        hour: 9,
      },
      db as never,
    );
    expect(rule.cronExpression).toBe('0 9 * * 1');
    expect(rule.status).toBe('ACTIVE');
    expect(new Date(rule.nextRunAt!).getUTCDay()).toBe(1);
    expect(db._audits.some((a: any) => a.action === 'automation.created')).toBe(true);
  });

  it('validates a CUSTOM cron and rejects a bad one', async () => {
    const db = makeDb();
    const ok = await createAutomation(
      {
        ...base,
        name: 'c',
        taskType: 'MONETIZATION_SCAN',
        cadence: 'CUSTOM',
        cronExpression: '0 6 1 * *',
      },
      db as never,
    );
    expect(ok.cronExpression).toBe('0 6 1 * *');
    await expect(
      createAutomation(
        {
          ...base,
          name: 'c',
          taskType: 'MONETIZATION_SCAN',
          cadence: 'CUSTOM',
          cronExpression: 'not cron',
        },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
    await expect(
      createAutomation(
        { ...base, name: 'c', taskType: 'MONETIZATION_SCAN', cadence: 'CUSTOM' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });

  it('validates task config (SEO alert severity, unknown keys)', async () => {
    const db = makeDb();
    const ok = await createAutomation(
      {
        ...base,
        name: 'alert',
        taskType: 'SEO_ISSUE_ALERT',
        cadence: 'DAILY',
        config: { severity: 'high' },
      },
      db as never,
    );
    expect((ok.config as { severity: string }).severity).toBe('high');
    await expect(
      createAutomation(
        {
          ...base,
          name: 'x',
          taskType: 'YOUTUBE_ANALYSIS',
          cadence: 'DAILY',
          config: { bogus: 1 },
        },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });

  it('refuses when the owner lacks the required permission', async () => {
    const db = makeDb({ role: 'VIEWER' }); // VIEWER has no crawl:run
    await expect(
      createAutomation(
        { ...base, name: 'crawl', taskType: 'WEBSITE_CRAWL', cadence: 'WEEKLY' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'permission_denied');
  });

  it('refuses when the acting user is not a member', async () => {
    const db = makeDb({ noMembership: true });
    await expect(
      createAutomation(
        { ...base, name: 'x', taskType: 'YOUTUBE_ANALYSIS', cadence: 'DAILY' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'permission_denied');
  });
});

describe('update / status / delete', () => {
  let db: ReturnType<typeof makeDb>;
  let ruleId: string;
  beforeEach(async () => {
    db = makeDb({ role: 'ADMIN' });
    const r = await createAutomation(
      { ...base, name: 'r', taskType: 'YOUTUBE_ANALYSIS', cadence: 'DAILY', hour: 9 },
      db as never,
    );
    ruleId = r.id;
  });

  it('update recomputes the schedule', async () => {
    const updated = await updateAutomation(
      { ...base, automationId: ruleId, cadence: 'WEEKLY', weekday: 3, hour: 8 },
      db as never,
    );
    expect(updated.cronExpression).toBe('0 8 * * 3');
    expect(db._audits.some((a: any) => a.action === 'automation.updated')).toBe(true);
  });

  it('pause clears nextRunAt; resume recomputes it and clears failures', async () => {
    const rule = db._rules[0];
    rule.failureCount = 4;
    rule.status = 'FAILING';
    const paused = await setAutomationStatus(
      { ...base, automationId: ruleId, status: 'PAUSED' },
      db as never,
    );
    expect(paused.status).toBe('PAUSED');
    expect(paused.nextRunAt).toBeNull();
    const resumed = await setAutomationStatus(
      { ...base, automationId: ruleId, status: 'ACTIVE' },
      db as never,
    );
    expect(resumed.status).toBe('ACTIVE');
    expect(resumed.failureCount).toBe(0);
    expect(resumed.nextRunAt).not.toBeNull();
  });

  it('delete removes the rule + audits it', async () => {
    await deleteAutomation({ ...base, automationId: ruleId }, db as never);
    expect(db._rules).toHaveLength(0);
    expect(db._audits.some((a: any) => a.action === 'automation.deleted')).toBe(true);
  });

  it('is tenant-scoped', async () => {
    await expect(
      updateAutomation(
        { organizationId: 'other', userId: 'u1', automationId: ruleId, cadence: 'DAILY' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });
});

describe('listAutomations / getAutomation', () => {
  it('shape the rule with a schedule label and last run', async () => {
    const db = makeDb({ role: 'MEMBER' });
    await createAutomation(
      { ...base, name: 'wk', taskType: 'GROWTH_REPORT', cadence: 'WEEKLY', weekday: 5, hour: 7 },
      db as never,
    );
    const list = await listAutomations('org1', db as never);
    expect(list[0]).toMatchObject({
      scheduleLabel: expect.stringContaining('Friday'),
      lastRun: null,
    });
    const detail = await getAutomation('org1', list[0]!.id, db as never);
    expect(detail?.runs).toEqual([]);
  });
});
