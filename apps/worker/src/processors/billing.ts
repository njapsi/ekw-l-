import { billing } from '@growth-agent/services';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Billing jobs (Phase 13). `runBillingReconcileJob`/`rebuildUsageCountersJob`
 * (`billing/jobs.ts`) existed since Phase 10 but nothing ever called them on
 * a schedule — this is what actually does.
 *
 *   reconcile        — repeatable, every 6h. Pulls the truth from Stripe for
 *                       every org with a subscription id and re-applies it
 *                       (self-heals a missed webhook), then rebuilds that
 *                       org's usage counters from the ledger.
 *   usage-alerts     — repeatable, every 15 min. 80/90/100% usage-threshold
 *                       notifications, idempotent per (org, meter, threshold,
 *                       period).
 *   trial-ending     — repeatable, every 6h. Warns an org a few days before
 *                       its trial ends; Stripe's own webhook still drives
 *                       the actual trial → active/past_due transition.
 */
export type BillingJob =
  | { type: 'reconcile' }
  | { type: 'usage-alerts' }
  | { type: 'trial-ending' };

export async function processBillingJob(job: Job<BillingJob>): Promise<unknown> {
  const data = job.data;
  logger.info({ jobId: job.id, type: data.type }, 'billing job');

  switch (data.type) {
    case 'reconcile':
      return billing.runBillingReconcileJob();
    case 'usage-alerts':
      return billing.runUsageAlertsJob();
    case 'trial-ending':
      return billing.runTrialEndingSoonJob();
    default: {
      const _exhaustive: never = data;
      throw new Error(`unknown billing job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
