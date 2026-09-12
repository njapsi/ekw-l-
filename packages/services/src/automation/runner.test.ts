import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertNoExternalPublish, TASK_TYPE_META } from './schemas.js';

const dispatchTask = vi.fn((..._a: unknown[]): Promise<unknown> =>
  Promise.resolve({ summary: 'ok' }),
);
vi.mock('./dispatch.js', () => ({ dispatchTask: (...a: unknown[]) => dispatchTask(...a) }));

const { claimRun, executeAutomationRun, retryDelayMs } = await import('./runner.js');

interface RuleSeed {
  status?: 'ACTIVE' | 'PAUSED' | 'FAILING' | 'DISABLED';
  ownerRole?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  ownerMissing?: boolean;
  maxRetries?: number;
  failureCount?: number;
  taskType?: keyof typeof TASK_TYPE_META;
}

function makeDb(rule: RuleSeed = {}, run: { status?: string; attempt?: number } = {}) {
  const ruleRow: any = {
    id: 'rule_1',
    organizationId: 'org1',
    ownerId: 'owner1',
    taskType: rule.taskType ?? 'YOUTUBE_ANALYSIS',
    cronExpression: '0 9 * * 1',
    status: rule.status ?? 'ACTIVE',
    maxRetries: rule.maxRetries ?? 3,
    failureCount: rule.failureCount ?? 0,
    totalRuns: 0,
    config: {},
  };
  const runRow: any = {
    id: 'run_1',
    automationRuleId: 'rule_1',
    organizationId: 'org1',
    status: run.status ?? 'PENDING',
    attempt: run.attempt ?? 1,
    scheduledFor: new Date('2026-03-02T09:00:00Z'),
  };
  const runs = new Map<string, any>([['run_1', runRow]]);
  const audits: any[] = [];
  let seq = 0;

  const db: any = {
    ruleRow,
    runRow,
    audits,
    membership: {
      findUnique: vi.fn(async () =>
        rule.ownerMissing ? null : { role: rule.ownerRole ?? 'MEMBER', status: 'ACTIVE' },
      ),
    },
    automationRun: {
      findUnique: vi.fn(async ({ where }: any) => runs.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const key = `${data.automationRuleId}:${data.scheduledFor.toISOString()}`;
        if (
          [...runs.values()].some(
            (r) => `${r.automationRuleId}:${r.scheduledFor.toISOString()}` === key,
          )
        ) {
          const e: any = new Error('unique');
          e.code = 'P2002';
          throw e;
        }
        const row = { id: `run_new_${++seq}`, ...data };
        runs.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = runs.get(where.id);
        for (const [k, v] of Object.entries(data)) {
          row[k] = incr(row[k], v);
        }
        return row;
      }),
    },
    automationRule: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === ruleRow.id ? ruleRow : null)),
      update: vi.fn(async ({ data }: any) => {
        for (const [k, v] of Object.entries(data)) ruleRow[k] = incr(ruleRow[k], v);
        return ruleRow;
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => void audits.push(data)) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

function incr(current: unknown, v: unknown): unknown {
  if (v && typeof v === 'object' && 'increment' in (v as object)) {
    return ((current as number) ?? 0) + (v as { increment: number }).increment;
  }
  return v;
}

beforeEach(() => {
  dispatchTask.mockReset();
  dispatchTask.mockResolvedValue({ summary: 'ok' });
});

describe('retryDelayMs', () => {
  it('is exponential and capped at 1h', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });
});

describe('claimRun — idempotency', () => {
  it('creates a run, then reports the second claim as not-claimed', async () => {
    const db = makeDb();
    const scheduledFor = new Date('2026-03-09T09:00:00Z');
    const a = await claimRun(
      { ruleId: 'rule_1', organizationId: 'org1', scheduledFor },
      db as never,
    );
    expect(a.claimed).toBe(true);
    const b = await claimRun(
      { ruleId: 'rule_1', organizationId: 'org1', scheduledFor },
      db as never,
    );
    expect(b.claimed).toBe(false);
  });
});

describe('executeAutomationRun', () => {
  it('runs the task, marks SUCCEEDED, resets failureCount and reschedules', async () => {
    const db = makeDb({ failureCount: 2, status: 'FAILING' });
    const res = await executeAutomationRun({ runId: 'run_1' }, db as never);
    expect(res.status).toBe('SUCCEEDED');
    expect(dispatchTask).toHaveBeenCalledOnce();
    expect(db.runRow.status).toBe('SUCCEEDED');
    expect(db.ruleRow.failureCount).toBe(0);
    expect(db.ruleRow.status).toBe('ACTIVE'); // FAILING → ACTIVE on success
    expect(db.ruleRow.nextRunAt).toBeInstanceOf(Date);
    expect(db.audits.some((a: any) => a.action === 'automation.run.succeeded')).toBe(true);
  });

  it('SKIPS the run without dispatching when the owner lost the required permission', async () => {
    const db = makeDb({ taskType: 'WEBSITE_CRAWL', ownerRole: 'VIEWER' });
    const res = await executeAutomationRun({ runId: 'run_1' }, db as never);
    expect(res.status).toBe('SKIPPED');
    expect(dispatchTask).not.toHaveBeenCalled();
    expect(db.runRow.status).toBe('SKIPPED');
    expect(db.ruleRow.status).toBe('PAUSED');
    expect(db.ruleRow.nextRunAt).toBeNull();
    expect(db.audits.some((a: any) => a.action === 'automation.run.skipped')).toBe(true);
  });

  it('SKIPS when the owner is no longer a member', async () => {
    const db = makeDb({ ownerMissing: true });
    const res = await executeAutomationRun({ runId: 'run_1' }, db as never);
    expect(res.status).toBe('SKIPPED');
    expect(res.error).toMatch(/no longer a member/);
  });

  it('on failure with retries left, schedules a retry with exponential backoff', async () => {
    dispatchTask.mockRejectedValueOnce(new Error('boom'));
    const db = makeDb({ maxRetries: 3 }, { attempt: 1 });
    const before = Date.now();
    const res = await executeAutomationRun({ runId: 'run_1' }, db as never);
    expect(res.status).toBe('RETRY_SCHEDULED');
    expect(db.runRow.status).toBe('RETRY_SCHEDULED');
    expect(db.runRow.attempt).toBe(2);
    const delay = new Date(db.runRow.nextAttemptAt).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(59_000);
    expect(delay).toBeLessThan(70_000);
    expect(db.ruleRow.failureCount).toBe(0); // not counted until the tick is terminal
  });

  it('after the last attempt, marks FAILED and bumps the rule failureCount', async () => {
    dispatchTask.mockRejectedValue(new Error('still broken'));
    const db = makeDb(
      { maxRetries: 3, failureCount: 0 },
      { status: 'RETRY_SCHEDULED', attempt: 3 },
    );
    const res = await executeAutomationRun({ runId: 'run_1' }, db as never);
    expect(res.status).toBe('FAILED');
    expect(db.runRow.status).toBe('FAILED');
    expect(db.ruleRow.failureCount).toBe(1);
    expect(db.ruleRow.lastRunStatus).toBe('FAILED');
    expect(db.ruleRow.nextRunAt).toBeInstanceOf(Date); // still scheduled
  });

  it('escalates to FAILING at 5 consecutive failures and DISABLED at 10', async () => {
    dispatchTask.mockRejectedValue(new Error('x'));
    const failing = makeDb({ maxRetries: 1, failureCount: 4 }, { attempt: 1 });
    await executeAutomationRun({ runId: 'run_1' }, failing as never);
    expect(failing.ruleRow.status).toBe('FAILING');

    const disabled = makeDb({ maxRetries: 1, failureCount: 9 }, { attempt: 1 });
    await executeAutomationRun({ runId: 'run_1' }, disabled as never);
    expect(disabled.ruleRow.status).toBe('DISABLED');
    expect(disabled.ruleRow.nextRunAt).toBeNull();
  });

  it('cancels the run if the rule was paused meanwhile', async () => {
    const db = makeDb({ status: 'PAUSED' });
    const res = await executeAutomationRun({ runId: 'run_1' }, db as never);
    expect(res.status).toBe('CANCELLED');
    expect(dispatchTask).not.toHaveBeenCalled();
  });
});

describe('no-external-publish invariant', () => {
  it('no automation task type requires publish:external', () => {
    expect(() => assertNoExternalPublish()).not.toThrow();
    for (const meta of Object.values(TASK_TYPE_META)) {
      expect(meta.requiredAction).not.toBe('publish:external');
      expect(meta.externalPublish).toBe(false);
    }
  });
});
