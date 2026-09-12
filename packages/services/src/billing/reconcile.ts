/**
 * Nightly reconcile: pull the truth from Stripe for orgs with a subscription id
 * and re-apply it, so a missed webhook self-heals. Also rebuilds usage
 * counters. Wired as a worker job (`billing/jobs.ts`); no queue is added in
 * this phase (ADR-0013 pattern) — it is safe to run from a cron shim.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { refreshUsageCounters } from '../usage/summary.js';
import type { BillingContext } from './service.js';
import { applyStripeSubscription } from './subscription.js';

const log = createLogger('billing.reconcile');

export async function reconcileOrganization(
  organizationId: string,
  ctx: BillingContext,
  db: Db = prisma,
): Promise<{ reconciled: boolean; reason?: string }> {
  const sub = await db.subscription.findUnique({ where: { organizationId } });
  if (!sub?.stripeSubscriptionId) {
    await refreshUsageCounters(organizationId, db);
    return { reconciled: false, reason: 'no stripe subscription' };
  }
  if (!ctx.gateway.configured) return { reconciled: false, reason: 'billing not configured' };

  const stripeSub = await ctx.gateway.getSubscription(sub.stripeSubscriptionId);
  await applyStripeSubscription(
    {
      organizationId,
      stripeSubscription: stripeSub,
      config: ctx.config,
      reason: 'nightly_reconcile',
    },
    db,
  );
  await refreshUsageCounters(organizationId, db);
  return { reconciled: true };
}

export async function reconcileAllOrganizations(
  ctx: BillingContext,
  db: Db = prisma,
): Promise<{ total: number; reconciled: number }> {
  const subs = await db.subscription.findMany({
    where: { stripeSubscriptionId: { not: null } },
    select: { organizationId: true },
  });
  let reconciled = 0;
  for (const { organizationId } of subs) {
    try {
      const r = await reconcileOrganization(organizationId, ctx, db);
      if (r.reconciled) reconciled++;
    } catch (err) {
      log.error({ err, organizationId }, 'reconcile failed for org');
    }
  }
  return { total: subs.length, reconciled };
}
