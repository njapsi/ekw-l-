/**
 * Automation job entry points. The worker's repeatable `automation` queue calls
 * `runAutomationSweepJob` (every minute) and `runAutomationRetrySweepJob`
 * (every 30s). Each due tick is claimed as an `AutomationRun` and then executed
 * — inline here (bounded: one analyst / crawl / report call), which keeps the
 * engine usable without a second worker process (ADR-0013).
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import {
  claimRun,
  dueAutomations,
  dueRetryRuns,
  executeAutomationRun,
  type ExecuteResult,
} from './runner.js';

const log = createLogger('automation.jobs');

export interface SweepResult {
  scanned: number;
  claimed: number;
  executed: number;
  results: Array<{ ruleId: string; runId: string; status: ExecuteResult['status'] }>;
}

/** Find rules whose `nextRunAt` has passed, claim a run for each, execute it. */
export async function runAutomationSweepJob(
  input: { now?: Date; execute?: boolean } = {},
  db: Db = prisma,
): Promise<SweepResult> {
  const now = input.now ?? new Date();
  const execute = input.execute ?? true;
  const rules = await dueAutomations(now, db);
  const results: SweepResult['results'] = [];
  let claimed = 0;
  let executed = 0;

  for (const rule of rules) {
    // Snap the tick to the rule's own nextRunAt so a double sweep dedupes.
    const scheduledFor = rule.nextRunAt ?? now;
    const claim = await claimRun(
      { ruleId: rule.id, organizationId: rule.organizationId, scheduledFor },
      db,
    );
    if (!claim.claimed) continue;
    claimed += 1;
    if (!execute) {
      results.push({ ruleId: rule.id, runId: claim.runId, status: 'RETRY_SCHEDULED' });
      continue;
    }
    try {
      const res = await executeAutomationRun({ runId: claim.runId }, db);
      executed += 1;
      results.push({ ruleId: rule.id, runId: claim.runId, status: res.status });
    } catch (err) {
      log.error({ err: String(err), ruleId: rule.id }, 'automation execution threw');
    }
  }

  if (rules.length) {
    log.info({ scanned: rules.length, claimed, executed }, 'automation sweep');
  }
  return { scanned: rules.length, claimed, executed, results };
}

/** Re-run `RETRY_SCHEDULED` runs whose `nextAttemptAt` has passed. */
export async function runAutomationRetrySweepJob(
  input: { now?: Date } = {},
  db: Db = prisma,
): Promise<{ picked: number; results: ExecuteResult[] }> {
  const now = input.now ?? new Date();
  const runs = await dueRetryRuns(now, db);
  const results: ExecuteResult[] = [];
  for (const run of runs) {
    try {
      results.push(await executeAutomationRun({ runId: run.id }, db));
    } catch (err) {
      log.error({ err: String(err), runId: run.id }, 'automation retry threw');
    }
  }
  if (runs.length) log.info({ picked: runs.length }, 'automation retry sweep');
  return { picked: runs.length, results };
}

/**
 * "Run now" — claim a one-off run for a rule and execute it immediately.
 * Bounded; used by the Server Action.
 */
export async function runAutomationNowJob(
  input: { organizationId: string; automationId: string; userId: string },
  db: Db = prisma,
): Promise<ExecuteResult> {
  const rule = await db.automationRule.findFirst({
    where: { id: input.automationId, organizationId: input.organizationId },
  });
  if (!rule) throw AppError.notFound('Automation');

  const claim = await claimRun(
    {
      ruleId: rule.id,
      organizationId: rule.organizationId,
      // Distinct key so it never collides with a scheduled tick.
      scheduledFor: new Date(),
      triggeredBy: 'manual',
    },
    db,
  );
  if (!claim.claimed) {
    throw new AppError('conflict', 'A run for this moment already exists — try again shortly.');
  }
  return executeAutomationRun({ runId: claim.runId }, db);
}
