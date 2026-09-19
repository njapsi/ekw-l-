import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchTask = vi.fn((..._a: unknown[]): Promise<unknown> =>
  Promise.resolve({ summary: 'ok' }),
);
vi.mock('./dispatch.js', () => ({ dispatchTask: (...a: unknown[]) => dispatchTask(...a) }));

const { runAutomationSweepJob, runAutomationRetrySweepJob, runAutomationNowJob } =
  await import('./jobs.js');

function incr(cur: unknown, v: unknown): unknown {
  if (v && typeof v === 'object' && 'increment' in (v as object)) {
    return ((cur as number) ?? 0) + (v as { increment: number }).increment;
  }
  return v;
}

function makeDb() {
  const rules: any[] = [];
  const runs: any[] = [];
  const audits: any[] = [];
  let seq = 0;

  const db: any = {
    rules,
    runs,
    audits,
    membership: { findUnique: vi.fn(async () => ({ role: 'MEMBER', status: 'ACTIVE' })) },
    // Phase 2: org state + AI governance lookups (live org, default policy).
    organization: {
      findUnique: vi.fn(async () => ({ deletedAt: null, deletionScheduledAt: null })),
    },
    aiGovernancePolicy: { findUnique: vi.fn(async () => null) },
    automationRule: {
      findMany: vi.fn(async ({ where }: any) =>
        rules.filter((r) => {
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (where.nextRunAt?.lte && !(r.nextRunAt && r.nextRunAt <= where.nextRunAt.lte))
            return false;
          return true;
        }),
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rules.find((r) => r.id === where.id && r.organizationId === where.organizationId) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: any) => rules.find((r) => r.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const r = rules.find((x) => x.id === where.id);
        for (const [k, v] of Object.entries(data)) r[k] = incr(r[k], v);
        return r;
      }),
    },
    automationRun: {
      create: vi.fn(async ({ data }: any) => {
        const key = `${data.automationRuleId}:${data.scheduledFor.toISOString()}`;
        if (runs.some((r) => `${r.automationRuleId}:${r.scheduledFor.toISOString()}` === key)) {
          const e: any = new Error('u');
          e.code = 'P2002';
          throw e;
        }
        const row = { id: `run_${++seq}`, ...data };
        runs.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return runs.find((r) => r.id === where.id) ?? null;
        const k = where.automationRuleId_scheduledFor;
        return (
          runs.find(
            (r) =>
              r.automationRuleId === k.automationRuleId &&
              r.scheduledFor.toISOString() === k.scheduledFor.toISOString(),
          ) ?? null
        );
      }),
      findMany: vi.fn(async ({ where }: any) =>
        runs.filter(
          (r) =>
            r.status === where.status &&
            (!where.nextAttemptAt?.lte ||
              (r.nextAttemptAt && r.nextAttemptAt <= where.nextAttemptAt.lte)),
        ),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const r = runs.find((x) => x.id === where.id);
        for (const [k, v] of Object.entries(data)) r[k] = incr(r[k], v);
        return r;
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => void audits.push(data)) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };

  const addRule = (over: Partial<Record<string, unknown>> = {}) => {
    const row = {
      id: `rule_${rules.length + 1}`,
      organizationId: 'org1',
      ownerId: 'owner1',
      taskType: 'YOUTUBE_ANALYSIS',
      cronExpression: '0 9 * * 1',
      status: 'ACTIVE',
      maxRetries: 3,
      failureCount: 0,
      totalRuns: 0,
      config: {},
      nextRunAt: new Date('2026-03-02T09:00:00Z'),
      ...over,
    };
    rules.push(row);
    return row;
  };
  return { db, addRule };
}

beforeEach(() => {
  dispatchTask.mockReset();
  dispatchTask.mockResolvedValue({ summary: 'done' });
});

describe('runAutomationSweepJob', () => {
  it('claims a run for each due ACTIVE/FAILING rule and executes it', async () => {
    const { db, addRule } = makeDb();
    addRule(); // due, ACTIVE
    addRule({ status: 'FAILING', nextRunAt: new Date('2026-03-01T09:00:00Z') }); // due, FAILING
    addRule({ status: 'PAUSED', nextRunAt: new Date('2026-03-01T09:00:00Z') }); // paused → not due
    addRule({ nextRunAt: new Date('2999-01-01T00:00:00Z') }); // future → not due

    const res = await runAutomationSweepJob({ now: new Date('2026-03-05T00:00:00Z') }, db as never);
    expect(res.scanned).toBe(2);
    expect(res.claimed).toBe(2);
    expect(res.executed).toBe(2);
    expect(res.results.every((r) => r.status === 'SUCCEEDED')).toBe(true);
    expect(dispatchTask).toHaveBeenCalledTimes(2);
  });

  it('a second sweep in the same window claims nothing (idempotent on the tick)', async () => {
    const { db, addRule } = makeDb();
    addRule();
    await runAutomationSweepJob({ now: new Date('2026-03-05T00:00:00Z') }, db as never);
    // The rule was rescheduled far ahead by the successful run, so make it due
    // again at the SAME nextRunAt to simulate a duplicate tick.
    db.rules[0].nextRunAt = new Date('2026-03-02T09:00:00Z');
    const again = await runAutomationSweepJob(
      { now: new Date('2026-03-05T00:00:00Z') },
      db as never,
    );
    expect(again.claimed).toBe(0);
  });
});

describe('runAutomationRetrySweepJob', () => {
  it('re-runs RETRY_SCHEDULED runs whose nextAttemptAt has passed', async () => {
    const { db, addRule } = makeDb();
    const rule = addRule();
    db.runs.push({
      id: 'run_r',
      automationRuleId: rule.id,
      organizationId: 'org1',
      status: 'RETRY_SCHEDULED',
      attempt: 2,
      scheduledFor: new Date('2026-03-02T09:00:00Z'),
      nextAttemptAt: new Date('2026-03-02T09:05:00Z'),
    });
    const res = await runAutomationRetrySweepJob(
      { now: new Date('2026-03-02T09:10:00Z') },
      db as never,
    );
    expect(res.picked).toBe(1);
    expect(res.results[0]?.status).toBe('SUCCEEDED');
  });

  it('ignores retries not yet due', async () => {
    const { db, addRule } = makeDb();
    const rule = addRule();
    db.runs.push({
      id: 'run_future',
      automationRuleId: rule.id,
      organizationId: 'org1',
      status: 'RETRY_SCHEDULED',
      attempt: 2,
      scheduledFor: new Date('2026-03-02T09:00:00Z'),
      nextAttemptAt: new Date('2999-01-01T00:00:00Z'),
    });
    const res = await runAutomationRetrySweepJob(
      { now: new Date('2026-03-02T09:10:00Z') },
      db as never,
    );
    expect(res.picked).toBe(0);
  });
});

describe('runAutomationNowJob', () => {
  it('claims a manual run and executes it immediately', async () => {
    const { db, addRule } = makeDb();
    const rule = addRule();
    const res = await runAutomationNowJob(
      { organizationId: 'org1', automationId: rule.id, userId: 'u1' },
      db as never,
    );
    expect(res.status).toBe('SUCCEEDED');
    expect(db.runs.find((r: any) => r.triggeredBy === 'manual')).toBeTruthy();
  });
});
