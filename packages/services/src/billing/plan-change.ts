/**
 * Upgrades, downgrades, cancellation and resume for an *existing* Stripe
 * subscription. A tier change is applied at Stripe (prorated on upgrade, at
 * period end on downgrade) and our mirror is refreshed from the returned
 * object; the authoritative confirmation still arrives via webhook.
 *
 * An org with no Stripe subscription (FREE) is directed to checkout instead.
 */
import { type BillingInterval, type BillingTier, type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { type BillingConfig, priceIdFor } from './config.js';
import type { BillingGateway } from './gateway.js';
import { getPlan, isDowngrade } from './plans.js';
import { applyStripeSubscription, getOrCreateSubscription } from './subscription.js';

export interface PlanChangeDeps {
  gateway: BillingGateway;
  config: BillingConfig;
  db?: Db;
}

export interface ChangePlanInput {
  organizationId: string;
  userId: string;
  tier: BillingTier;
  interval?: BillingInterval;
}

export type ChangePlanResult =
  | { kind: 'changed'; tier: BillingTier; interval: BillingInterval }
  | { kind: 'needs_checkout'; reason: string };

export async function changePlan(
  input: ChangePlanInput,
  deps: PlanChangeDeps,
): Promise<ChangePlanResult> {
  const db = deps.db ?? prisma;
  const plan = getPlan(input.tier);
  if (!plan.selfServe) {
    throw AppError.validation(
      input.tier === 'ENTERPRISE'
        ? 'Enterprise plans are managed with our team — contact sales.'
        : `The ${plan.name} plan cannot be selected directly.`,
    );
  }

  const sub = await getOrCreateSubscription(input.organizationId, db);
  const interval = input.interval ?? sub.interval;

  if (input.tier === sub.tier && interval === sub.interval && !sub.cancelAtPeriodEnd) {
    throw AppError.validation(`You're already on the ${plan.name} plan.`);
  }

  if (!sub.stripeSubscriptionId) {
    return { kind: 'needs_checkout', reason: 'No active paid subscription — start checkout.' };
  }
  if (!deps.gateway.configured) {
    throw new AppError('provider_unavailable', 'Billing is not configured on this deployment.');
  }

  const priceId = priceIdFor(deps.config, input.tier, interval);
  if (!priceId) {
    throw new AppError(
      'provider_unavailable',
      `No Stripe price configured for ${plan.name} (${interval.toLowerCase()}).`,
      { expose: false },
    );
  }

  const downgrade = isDowngrade(sub.tier, input.tier);
  const stripeSub = await deps.gateway.updateSubscription(sub.stripeSubscriptionId, {
    priceId,
    cancelAtPeriodEnd: false,
    prorationBehavior: downgrade ? 'none' : 'create_prorations',
    metadata: { organizationId: input.organizationId, tier: input.tier, interval },
  });

  await applyStripeSubscription(
    {
      organizationId: input.organizationId,
      stripeSubscription: stripeSub,
      config: deps.config,
      actorId: input.userId,
      reason: downgrade ? 'downgrade' : 'upgrade',
    },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: downgrade ? 'billing.plan.downgraded' : 'billing.plan.upgraded',
      targetType: 'subscription',
      targetId: sub.id,
      metadata: { fromTier: sub.tier, toTier: input.tier, interval },
    },
    db,
  );
  return { kind: 'changed', tier: input.tier, interval };
}

export async function cancelSubscription(
  input: { organizationId: string; userId: string; immediately?: boolean },
  deps: PlanChangeDeps,
): Promise<{ cancelAtPeriodEnd: boolean; endsAt: string | null }> {
  const db = deps.db ?? prisma;
  const sub = await getOrCreateSubscription(input.organizationId, db);
  if (!sub.stripeSubscriptionId) {
    throw AppError.validation('There is no paid subscription to cancel.');
  }
  if (!deps.gateway.configured) {
    throw new AppError('provider_unavailable', 'Billing is not configured on this deployment.');
  }

  const stripeSub = await deps.gateway.cancelSubscription(sub.stripeSubscriptionId, {
    atPeriodEnd: !input.immediately,
  });
  const updated = await applyStripeSubscription(
    {
      organizationId: input.organizationId,
      stripeSubscription: stripeSub,
      config: deps.config,
      actorId: input.userId,
      reason: input.immediately ? 'cancel_now' : 'cancel_at_period_end',
    },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'billing.subscription.cancel_requested',
      targetType: 'subscription',
      targetId: sub.id,
      metadata: { immediately: Boolean(input.immediately) },
    },
    db,
  );
  return {
    cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
    endsAt: updated.currentPeriodEnd?.toISOString() ?? null,
  };
}

export async function resumeSubscription(
  input: { organizationId: string; userId: string },
  deps: PlanChangeDeps,
): Promise<{ resumed: boolean }> {
  const db = deps.db ?? prisma;
  const sub = await getOrCreateSubscription(input.organizationId, db);
  if (!sub.stripeSubscriptionId) {
    throw AppError.validation('There is no paid subscription to resume.');
  }
  if (!sub.cancelAtPeriodEnd) {
    throw AppError.validation('This subscription is not scheduled to cancel.');
  }
  if (!deps.gateway.configured) {
    throw new AppError('provider_unavailable', 'Billing is not configured on this deployment.');
  }

  const stripeSub = await deps.gateway.updateSubscription(sub.stripeSubscriptionId, {
    cancelAtPeriodEnd: false,
  });
  await applyStripeSubscription(
    {
      organizationId: input.organizationId,
      stripeSubscription: stripeSub,
      config: deps.config,
      actorId: input.userId,
      reason: 'resume',
    },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'billing.subscription.resumed',
      targetType: 'subscription',
      targetId: sub.id,
    },
    db,
  );
  return { resumed: true };
}
