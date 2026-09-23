/**
 * The `Subscription` row is a mirror of Stripe (the source of truth for money).
 * Webhooks and the reconcile job call `applyStripeSubscription` to keep it in
 * sync; the rest of the app reads `getSubscription` / `getBillingSummary`.
 * A FREE org has a row with tier FREE and no Stripe ids.
 */
import {
  type BillingInterval,
  type Db,
  type SubscriptionStatus,
  type BillingTier,
  prisma,
} from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { createNotification } from '../notifications/index.js';
import { getUsageSummary } from '../usage/summary.js';
import { type BillingConfig, tierForPrice } from './config.js';
import { resolveEntitlements, syncPlanEntitlements } from './entitlements.js';
import { getPlan, listPlans } from './plans.js';
import type { StripeSubscription } from './gateway.js';

const STRIPE_STATUS: Record<string, SubscriptionStatus> = {
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  canceled: 'CANCELED',
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'INCOMPLETE_EXPIRED',
  unpaid: 'UNPAID',
  paused: 'PAUSED',
};

export function mapStripeStatus(status: string): SubscriptionStatus {
  return STRIPE_STATUS[status] ?? 'INCOMPLETE';
}

/** Statuses that keep full product access. */
export function isEntitledStatus(status: SubscriptionStatus): boolean {
  return status === 'ACTIVE' || status === 'TRIALING' || status === 'PAST_DUE';
}

export function describeStatus(status: SubscriptionStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'Active';
    case 'TRIALING':
      return 'Trial';
    case 'PAST_DUE':
      return 'Payment past due';
    case 'UNPAID':
      return 'Unpaid';
    case 'CANCELED':
      return 'Canceled';
    case 'PAUSED':
      return 'Paused';
    case 'INCOMPLETE':
    case 'INCOMPLETE_EXPIRED':
      return 'Awaiting payment';
    default:
      return status;
  }
}

function fromUnix(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

export async function getOrCreateSubscription(organizationId: string, db: Db = prisma) {
  const existing = await db.subscription.findUnique({ where: { organizationId } });
  if (existing) return existing;
  const created = await db.subscription.create({
    data: { organizationId, tier: 'FREE', status: 'ACTIVE' },
  });
  await syncPlanEntitlements(organizationId, 'FREE', db);
  return created;
}

export async function getSubscription(organizationId: string, db: Db = prisma) {
  return db.subscription.findUnique({ where: { organizationId } });
}

/**
 * Apply a Stripe subscription object to our mirror. Resolves the tier + interval
 * from the price id via env config; unknown prices keep the current tier and are
 * flagged in the audit metadata. Re-syncs plan entitlements when the tier moves.
 */
export async function applyStripeSubscription(
  input: {
    organizationId: string;
    stripeSubscription: StripeSubscription;
    config: BillingConfig;
    actorId?: string | null;
    reason?: string;
  },
  db: Db = prisma,
) {
  const s = input.stripeSubscription;
  const item = s.items.data[0];
  const priceId = item?.price.id ?? null;
  const mapped = priceId ? tierForPrice(input.config, priceId) : null;

  const current = await getOrCreateSubscription(input.organizationId, db);

  const status = mapStripeStatus(s.status);
  const canceledToFree = status === 'CANCELED';
  const tier: BillingTier = canceledToFree ? 'FREE' : (mapped?.tier ?? current.tier);
  const interval: BillingInterval =
    mapped?.interval ?? (item?.price.recurring?.interval === 'year' ? 'YEAR' : current.interval);

  const updated = await db.subscription.update({
    where: { organizationId: input.organizationId },
    data: {
      tier,
      status,
      interval,
      seats: item?.quantity ?? current.seats,
      stripeCustomerId: s.customer,
      stripeSubscriptionId: s.id,
      stripePriceId: priceId,
      currentPeriodStart: fromUnix(s.current_period_start),
      currentPeriodEnd: fromUnix(s.current_period_end),
      cancelAtPeriodEnd: s.cancel_at_period_end,
      canceledAt: fromUnix(s.canceled_at),
      trialEndsAt: fromUnix(s.trial_end),
    },
  });

  if (tier !== current.tier) {
    await syncPlanEntitlements(input.organizationId, tier, db);
  }

  // A move *into* a delinquent state that the owner should see. Idempotent on
  // the dedupe key (sub id + period end), so a repeated sync is a no-op.
  if ((status === 'PAST_DUE' || status === 'UNPAID') && current.status !== status) {
    await createNotification(
      {
        organizationId: input.organizationId,
        kind: 'billing.past_due',
        level: 'WARNING',
        title: status === 'UNPAID' ? 'Subscription unpaid' : 'Subscription past due',
        body: 'We could not collect your latest subscription payment. Update your payment method in the billing portal to avoid losing access.',
        linkPath: '/app/billing',
        dedupeKey: `billing-past-due:${s.id}:${s.current_period_end ?? 'na'}`,
        sourceType: 'subscription',
        sourceId: updated.id,
      },
      db,
    );
  }

  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      actorType: input.actorId ? 'USER' : 'SYSTEM',
      action: 'billing.subscription.synced',
      targetType: 'subscription',
      targetId: updated.id,
      metadata: {
        reason: input.reason ?? 'stripe_sync',
        fromTier: current.tier,
        toTier: tier,
        status,
        priceId,
        priceRecognized: Boolean(mapped) || canceledToFree,
      },
    },
    db,
  );

  return updated;
}

/** Move an org to FREE (used when a subscription is deleted at Stripe). */
export async function downgradeToFree(
  input: { organizationId: string; actorId?: string | null; reason?: string },
  db: Db = prisma,
) {
  const current = await getOrCreateSubscription(input.organizationId, db);
  const updated = await db.subscription.update({
    where: { organizationId: input.organizationId },
    data: {
      tier: 'FREE',
      status: 'CANCELED',
      stripeSubscriptionId: null,
      stripePriceId: null,
      cancelAtPeriodEnd: false,
      canceledAt: new Date(),
      currentPeriodEnd: current.currentPeriodEnd,
    },
  });
  await syncPlanEntitlements(input.organizationId, 'FREE', db);
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      actorType: input.actorId ? 'USER' : 'SYSTEM',
      action: 'billing.subscription.downgraded_to_free',
      targetType: 'subscription',
      targetId: updated.id,
      metadata: { reason: input.reason ?? 'stripe_subscription_deleted', fromTier: current.tier },
    },
    db,
  );
  return updated;
}

export interface SeatSummary {
  active: number;
  /** Pending invitations — not accepted, not revoked, not expired. */
  invited: number;
  limit: number | null;
  /** `null` when the seat limit is unlimited. Floored at 0 — invited seats
   *  can put an org at or past its limit even before anyone new joins
   *  (§42: "do not double-charge the same user unexpectedly" — this is the
   *  read the UI uses to warn *before* an invite would tip the org over). */
  available: number | null;
}

export interface BillingSummary {
  tier: BillingTier;
  planName: string;
  status: SubscriptionStatus;
  statusLabel: string;
  entitled: boolean;
  interval: BillingInterval;
  seats: number;
  seatSummary: SeatSummary;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  hasStripeSubscription: boolean;
  hasStripeCustomer: boolean;
  features: Record<string, boolean>;
  plans: ReturnType<typeof listPlans>;
  usage: Awaited<ReturnType<typeof getUsageSummary>>;
  invoices: Array<{
    id: string;
    number: string | null;
    status: string;
    amountDue: number;
    amountPaid: number;
    currency: string;
    hostedInvoiceUrl: string | null;
    invoicePdfUrl: string | null;
    createdAt: string;
  }>;
}

export async function getBillingSummary(
  organizationId: string,
  db: Db = prisma,
): Promise<BillingSummary> {
  const sub = await getOrCreateSubscription(organizationId, db);
  const [{ features, limits }, usage, invoices, activeSeats, invitedSeats] = await Promise.all([
    resolveEntitlements(organizationId, db),
    getUsageSummary(organizationId, db),
    db.invoice.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 24,
    }),
    db.membership.count({ where: { organizationId, status: 'ACTIVE' } }),
    db.invitation.count({
      where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);

  return {
    tier: sub.tier,
    planName: getPlan(sub.tier).name,
    status: sub.status,
    statusLabel: describeStatus(sub.status),
    entitled: isEntitledStatus(sub.status),
    interval: sub.interval,
    seats: sub.seats,
    seatSummary: {
      active: activeSeats,
      invited: invitedSeats,
      limit: limits.SEATS,
      available: limits.SEATS == null ? null : Math.max(0, limits.SEATS - activeSeats - invitedSeats),
    },
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    hasStripeSubscription: Boolean(sub.stripeSubscriptionId),
    hasStripeCustomer: Boolean(sub.stripeCustomerId),
    features,
    plans: listPlans(),
    usage,
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      amountDue: i.amountDue,
      amountPaid: i.amountPaid,
      currency: i.currency,
      hostedInvoiceUrl: i.hostedInvoiceUrl,
      invoicePdfUrl: i.invoicePdfUrl,
      createdAt: i.createdAt.toISOString(),
    })),
  };
}
