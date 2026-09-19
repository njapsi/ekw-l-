/**
 * The automation execution engine.
 *
 *   dueAutomations()      → rules whose nextRunAt has passed (ACTIVE / FAILING).
 *   claimRun()            → creates the AutomationRun for a (rule, tick) pair.
 *                           The `@@unique([automationRuleId, scheduledFor])`
 *                           makes a double sweep a no-op — idempotency.
 *   executeAutomationRun()→ re-checks the OWNER's RBAC (SKIPPED if lost),
 *                           dispatches the task, and on failure schedules a
 *                           retry with exponential backoff up to `maxRetries`.
 *
 * Consecutive failures escalate the rule: 5 → FAILING, 10 → DISABLED.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { createNotification } from '../notifications/index.js';
import { runInTransaction } from '../db-tx.js';
import { authorize } from '../rbac/authorize.js';
import { nextRunAfter } from './cron.js';
import { dispatchTask } from './dispatch.js';
import { automationBlockReason, resolveOwnerAuthz } from './rules.js';
import { TASK_TYPE_META } from './schemas.js';

const log = createLogger('automation.runner');

/** Backoff: base 60s, doubled per attempt, capped at 1h. */
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 60 * 60_000;
const FAILING_AT = 5;
const DISABLE_AT = 10;

export function retryDelayMs(attempt: number): number {
  const d = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(RETRY_CAP_MS, d);
}

export async function dueAutomations(now: Date, db: Db = prisma, limit = 200) {
  // tenant-scope-ok: platform scheduler sweep across all orgs; each run then
  // executes scoped to its own rule.organizationId.
  return db.automationRule.findMany({
    where: {
      status: { in: ['ACTIVE', 'FAILING'] },
      nextRunAt: { not: null, lte: now },
      // An organization in its deletion grace period runs no background work
      // (Phase 2 finding: automations previously kept running until purge).
      organization: { deletedAt: null, deletionScheduledAt: null },
    },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
  });
}

export async function dueRetryRuns(now: Date, db: Db = prisma, limit = 200) {
  return db.automationRun.findMany({
    where: {
      status: 'RETRY_SCHEDULED',
      nextAttemptAt: { not: null, lte: now },
      organization: { deletedAt: null, deletionScheduledAt: null },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
  });
}

export interface ClaimResult {
  runId: string;
  claimed: boolean;
}

/**
 * Create the run row for this tick, or report that it already exists. The
 * `scheduledFor` is snapped to the rule's own `nextRunAt` so two sweeps in the
 * same window produce the same key.
 */
export async function claimRun(
  input: { ruleId: string; organizationId: string; scheduledFor: Date; triggeredBy?: string },
  db: Db = prisma,
): Promise<ClaimResult> {
  try {
    const run = await db.automationRun.create({
      data: {
        automationRuleId: input.ruleId,
        organizationId: input.organizationId,
        scheduledFor: input.scheduledFor,
        status: 'PENDING',
        attempt: 1,
        triggeredBy: input.triggeredBy ?? 'schedule',
      },
    });
    return { runId: run.id, claimed: true };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      const existing = await db.automationRun.findUnique({
        where: {
          automationRuleId_scheduledFor: {
            automationRuleId: input.ruleId,
            scheduledFor: input.scheduledFor,
          },
        },
        select: { id: true },
      });
      return { runId: existing?.id ?? '', claimed: false };
    }
    throw err;
  }
}

export interface ExecuteResult {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'RETRY_SCHEDULED' | 'CANCELLED';
  summary?: string;
  error?: string;
}

/**
 * Run one `AutomationRun` to completion. Safe to call repeatedly — a run that
 * is not PENDING / RETRY_SCHEDULED is returned untouched.
 */
export async function executeAutomationRun(
  input: { runId: string },
  db: Db = prisma,
): Promise<ExecuteResult> {
  const run = await db.automationRun.findUnique({ where: { id: input.runId } });
  if (!run) throw new Error(`automation run ${input.runId} not found`);
  if (run.status !== 'PENDING' && run.status !== 'RETRY_SCHEDULED') {
    return { runId: run.id, status: run.status as ExecuteResult['status'] };
  }

  const rule = await db.automationRule.findUnique({ where: { id: run.automationRuleId } });
  if (!rule) throw new Error(`automation rule ${run.automationRuleId} not found`);

  if (rule.status === 'PAUSED' || rule.status === 'DISABLED') {
    await db.automationRun.update({
      where: { id: run.id },
      data: { status: 'CANCELLED', finishedAt: new Date(), error: `rule is ${rule.status}` },
    });
    return { runId: run.id, status: 'CANCELLED' };
  }

  // --- owner permission re-check (ADR-0027) ---------------------------
  const authz = await resolveOwnerAuthz(rule.ownerId, rule.organizationId, db);
  const requiredAction = TASK_TYPE_META[rule.taskType].requiredAction;
  const permitted = (() => {
    if (!authz) return false;
    try {
      authorize(
        { userId: rule.ownerId, role: authz.role, membershipStatus: authz.membershipStatus },
        requiredAction,
      );
      return true;
    } catch {
      return false;
    }
  })();

  // Organization-level guardrails, re-checked at run time: the AI governance
  // policy may have removed this task type since the rule was created.
  const blockReason = permitted
    ? await automationBlockReason(rule.organizationId, rule.taskType, db)
    : null;

  if (!permitted || blockReason) {
    const reason =
      blockReason ??
      (authz
        ? `owner lacks "${requiredAction}"`
        : 'owner is no longer a member of the organization');
    await runInTransaction(db, async (tx) => {
      await tx.automationRun.update({
        where: { id: run.id },
        data: { status: 'SKIPPED', startedAt: new Date(), finishedAt: new Date(), error: reason },
      });
      await tx.automationRule.update({
        where: { id: rule.id },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: 'SKIPPED',
          lastError: reason,
          status: 'PAUSED',
          nextRunAt: null,
          totalRuns: { increment: 1 },
        },
      });
    });
    await recordAudit(
      {
        organizationId: rule.organizationId,
        actorType: 'SYSTEM',
        action: 'automation.run.skipped',
        targetType: 'automation_run',
        targetId: run.id,
        metadata: { ruleId: rule.id, taskType: rule.taskType, reason },
      },
      db,
    );
    log.warn({ ruleId: rule.id, reason }, 'automation run skipped — owner permission');
    return { runId: run.id, status: 'SKIPPED', error: reason };
  }

  // --- execute -----------------------------------------------------
  const startedAt = new Date();
  await db.automationRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt, nextAttemptAt: null },
  });

  try {
    const result = await dispatchTask(
      rule.taskType,
      {
        organizationId: rule.organizationId,
        ownerId: rule.ownerId,
        ruleId: rule.id,
        runId: run.id,
        config: (rule.config as Record<string, unknown>) ?? {},
      },
      db,
    );
    const finishedAt = new Date();
    const nextRunAt = safeNext(rule.cronExpression, finishedAt);
    await runInTransaction(db, async (tx) => {
      await tx.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          output: { summary: result.summary, ...(result.detail ?? {}) } as never,
          error: null,
        },
      });
      await tx.automationRule.update({
        where: { id: rule.id },
        data: {
          lastRunAt: finishedAt,
          lastRunStatus: 'SUCCEEDED',
          nextRunAt,
          failureCount: 0,
          lastError: null,
          totalRuns: { increment: 1 },
          status: rule.status === 'FAILING' ? 'ACTIVE' : rule.status,
        },
      });
    });
    await recordAudit(
      {
        organizationId: rule.organizationId,
        actorType: 'SYSTEM',
        action: 'automation.run.succeeded',
        targetType: 'automation_run',
        targetId: run.id,
        metadata: { ruleId: rule.id, taskType: rule.taskType, summary: result.summary },
      },
      db,
    );
    return { runId: run.id, status: 'SUCCEEDED', summary: result.summary };
  } catch (err) {
    return handleFailure({ run, rule, startedAt, err }, db);
  }
}

async function handleFailure(
  args: {
    run: { id: string; attempt: number };
    rule: {
      id: string;
      organizationId: string;
      taskType: string;
      cronExpression: string;
      maxRetries: number;
      failureCount: number;
    };
    startedAt: Date;
    err: unknown;
  },
  db: Db,
): Promise<ExecuteResult> {
  const { run, rule } = args;
  const message = (args.err instanceof Error ? args.err.message : String(args.err)).slice(0, 500);
  const finishedAt = new Date();
  const willRetry = run.attempt < rule.maxRetries;

  if (willRetry) {
    const nextAttemptAt = new Date(finishedAt.getTime() + retryDelayMs(run.attempt));
    await db.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'RETRY_SCHEDULED',
        attempt: { increment: 1 },
        finishedAt,
        durationMs: finishedAt.getTime() - args.startedAt.getTime(),
        error: message,
        nextAttemptAt,
      },
    });
    await recordAudit(
      {
        organizationId: rule.organizationId,
        actorType: 'SYSTEM',
        action: 'automation.run.retry_scheduled',
        targetType: 'automation_run',
        targetId: run.id,
        metadata: {
          ruleId: rule.id,
          attempt: run.attempt,
          nextAttemptAt: nextAttemptAt.toISOString(),
          error: message,
        },
      },
      db,
    );
    log.warn(
      { ruleId: rule.id, attempt: run.attempt, nextAttemptAt },
      'automation run failed; retry scheduled',
    );
    return { runId: run.id, status: 'RETRY_SCHEDULED', error: message };
  }

  // Terminal failure for this tick.
  const failureCount = rule.failureCount + 1;
  const nextStatus =
    failureCount >= DISABLE_AT ? 'DISABLED' : failureCount >= FAILING_AT ? 'FAILING' : undefined;
  const nextRunAt = nextStatus === 'DISABLED' ? null : safeNext(rule.cronExpression, finishedAt);

  await runInTransaction(db, async (tx) => {
    await tx.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt,
        durationMs: finishedAt.getTime() - args.startedAt.getTime(),
        error: message,
        nextAttemptAt: null,
      },
    });
    await tx.automationRule.update({
      where: { id: rule.id },
      data: {
        lastRunAt: finishedAt,
        lastRunStatus: 'FAILED',
        lastError: message,
        failureCount,
        totalRuns: { increment: 1 },
        nextRunAt,
        ...(nextStatus ? { status: nextStatus } : {}),
      },
    });
  });
  await recordAudit(
    {
      organizationId: rule.organizationId,
      actorType: 'SYSTEM',
      action: 'automation.run.failed',
      targetType: 'automation_run',
      targetId: run.id,
      metadata: { ruleId: rule.id, failureCount, nextStatus: nextStatus ?? null, error: message },
    },
    db,
  );
  log.error(
    { ruleId: rule.id, failureCount, nextStatus },
    'automation run failed (no more retries)',
  );

  // Tell the rule's owner when it crosses into FAILING / DISABLED — the point
  // at which a human needs to look (FORENSIC-AUDIT M-1).
  if (nextStatus) {
    const meta = await db.automationRule
      .findUnique({ where: { id: rule.id }, select: { name: true, ownerId: true } })
      .catch(() => null);
    if (meta) {
      await createNotification(
        {
          organizationId: rule.organizationId,
          userId: meta.ownerId,
          kind: `automation.${nextStatus.toLowerCase()}`,
          level: nextStatus === 'DISABLED' ? 'CRITICAL' : 'WARNING',
          title:
            nextStatus === 'DISABLED'
              ? `Automation disabled: ${meta.name}`
              : `Automation failing: ${meta.name}`,
          body:
            nextStatus === 'DISABLED'
              ? `"${meta.name}" failed ${failureCount} times in a row and has been disabled. Re-enable it after fixing the cause.`
              : `"${meta.name}" has failed ${failureCount} times in a row. It is still scheduled; check the execution log.`,
          linkPath: `/app/automations/${rule.id}`,
          dedupeKey: `automation:${rule.id}:${nextStatus}:${failureCount}`,
          sourceType: 'automation_rule',
          sourceId: rule.id,
        },
        db,
      );
    }
  }

  return { runId: run.id, status: 'FAILED', error: message };
}

function safeNext(cron: string, from: Date): Date | null {
  try {
    return nextRunAfter(cron, from);
  } catch {
    return null;
  }
}

/** Manually cancel a PENDING / RETRY_SCHEDULED run (used by "cancel" in the UI). */
export async function cancelRun(
  input: { organizationId: string; userId: string; runId: string },
  db: Db = prisma,
): Promise<void> {
  const run = await db.automationRun.findFirst({
    where: { id: input.runId, organizationId: input.organizationId },
  });
  if (!run) return;
  if (run.status !== 'PENDING' && run.status !== 'RETRY_SCHEDULED' && run.status !== 'RUNNING') {
    return;
  }
  await db.automationRun.update({
    where: { id: run.id },
    data: {
      status: 'CANCELLED',
      finishedAt: new Date(),
      nextAttemptAt: null,
      error: 'cancelled by user',
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'automation.run.cancelled',
      targetType: 'automation_run',
      targetId: run.id,
      metadata: { ruleId: run.automationRuleId },
    },
    db,
  );
}
