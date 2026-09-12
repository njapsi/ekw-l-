import { automation, organizations } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Automation-engine jobs (operator's "Phase 12").
 *
 *   sweep        — repeatable, every minute. Finds rules whose `nextRunAt`
 *                  passed, claims one idempotent `AutomationRun` each, executes.
 *   retry-sweep  — repeatable, every 30s. Re-runs `RETRY_SCHEDULED` runs whose
 *                  exponential-backoff `nextAttemptAt` has arrived.
 *   execute      — a single run by id (used when a sweep hands work off).
 *   lifecycle-sweep — repeatable, hourly. Hard-deletes organizations and
 *                  anonymises users whose deletion grace window has elapsed
 *                  (FORENSIC-AUDIT M-2).
 */
export type AutomationJob =
  | { type: 'sweep' }
  | { type: 'retry-sweep' }
  | { type: 'execute'; runId: string }
  | { type: 'lifecycle-sweep' };

export async function processAutomationJob(job: Job<AutomationJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type }, 'automation job');

  switch (data.type) {
    case 'sweep':
      return automation.runAutomationSweepJob();
    case 'retry-sweep':
      return automation.runAutomationRetrySweepJob();
    case 'execute':
      return automation.executeAutomationRun({ runId: data.runId });
    case 'lifecycle-sweep':
      return organizations.runLifecycleSweepJob();
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown automation job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
