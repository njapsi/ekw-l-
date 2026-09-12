/**
 * Stripe webhook processing. Two idempotency guarantees (master instruction:
 * "Make webhook processing idempotent"):
 *
 *  1. The `BillingEvent` ledger: the row id IS the Stripe event id. A
 *     redelivery finds an existing row and is skipped before any work.
 *  2. Every handler is an upsert keyed on a Stripe id (subscription id,
 *     invoice id), so even a torn/retried processing run converges.
 *
 * The signature is verified first (`gateway.parseWebhookEvent`); an invalid
 * signature throws and the route returns 400.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { createNotification } from '../notifications/index.js';
import type { BillingConfig } from './config.js';
import type { BillingGateway, StripeEvent, StripeInvoice, StripeSubscription } from './gateway.js';
import { upsertInvoiceFromStripe } from './invoices.js';
import { applyStripeSubscription, downgradeToFree } from './subscription.js';

const log = createLogger('billing.webhook');

export interface WebhookDeps {
  gateway: BillingGateway;
  config: BillingConfig;
  db?: Db;
}

export interface WebhookResult {
  received: true;
  eventId: string;
  type: string;
  outcome: 'processed' | 'deduped' | 'skipped' | 'failed';
  detail?: string;
}

const HANDLED_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
]);

export async function handleStripeWebhook(
  input: { rawBody: string; signature: string | null },
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const db = deps.db ?? prisma;
  // Throws on a bad signature → route returns 400.
  const event = deps.gateway.parseWebhookEvent(input.rawBody, input.signature);

  // 1) Ledger-level idempotency. Claim the event id or bail if already claimed.
  const existing = await db.billingEvent.findUnique({ where: { id: event.id } });
  if (existing) {
    if (existing.status === 'PROCESSED' || existing.status === 'SKIPPED') {
      return { received: true, eventId: event.id, type: event.type, outcome: 'deduped' };
    }
    // A prior attempt failed mid-flight; fall through and retry it.
    log.warn({ eventId: event.id, status: existing.status }, 'retrying a previously failed event');
  } else {
    try {
      await db.billingEvent.create({
        data: { id: event.id, type: event.type, status: 'RECEIVED', payload: event as never },
      });
    } catch (err) {
      // Concurrent delivery already inserted it — treat as a dedupe.
      if ((err as { code?: string }).code === 'P2002') {
        return { received: true, eventId: event.id, type: event.type, outcome: 'deduped' };
      }
      throw err;
    }
  }

  if (!HANDLED_TYPES.has(event.type)) {
    await db.billingEvent.update({
      where: { id: event.id },
      data: { status: 'SKIPPED', processedAt: new Date() },
    });
    return { received: true, eventId: event.id, type: event.type, outcome: 'skipped' };
  }

  try {
    const detail = await dispatch(event, deps, db);
    await db.billingEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', processedAt: new Date(), error: null },
    });
    return { received: true, eventId: event.id, type: event.type, outcome: 'processed', detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ eventId: event.id, type: event.type, err: message }, 'webhook handler failed');
    await db.billingEvent.update({
      where: { id: event.id },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    // Rethrow so Stripe retries later (the ledger row stays FAILED and is
    // retried on redelivery).
    throw err;
  }
}

async function dispatch(event: StripeEvent, deps: WebhookDeps, db: Db): Promise<string> {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(obj, deps, db);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return handleSubscriptionUpsert(obj as unknown as StripeSubscription, deps, db);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(obj as unknown as StripeSubscription, db);
    default:
      return handleInvoiceEvent(event.type, obj as unknown as StripeInvoice, db);
  }
}

async function resolveOrgId(
  hints: {
    organizationId?: string | null;
    customerId?: string | null;
    subscriptionId?: string | null;
  },
  db: Db,
): Promise<string | null> {
  if (hints.organizationId) {
    const byId = await db.organization.findUnique({
      where: { id: hints.organizationId },
      select: { id: true },
    });
    if (byId) return byId.id;
  }
  if (hints.subscriptionId) {
    const bySub = await db.subscription.findUnique({
      where: { stripeSubscriptionId: hints.subscriptionId },
      select: { organizationId: true },
    });
    if (bySub) return bySub.organizationId;
  }
  if (hints.customerId) {
    const byCust = await db.subscription.findUnique({
      where: { stripeCustomerId: hints.customerId },
      select: { organizationId: true },
    });
    if (byCust) return byCust.organizationId;
  }
  return null;
}

async function handleCheckoutCompleted(
  obj: Record<string, unknown>,
  deps: WebhookDeps,
  db: Db,
): Promise<string> {
  const customerId = (obj.customer as string | null) ?? null;
  const subscriptionId = (obj.subscription as string | null) ?? null;
  const clientRef = (obj.client_reference_id as string | null) ?? null;
  const metaOrg =
    ((obj.metadata as Record<string, string> | null)?.organizationId as string) ?? null;

  const organizationId = await resolveOrgId(
    { organizationId: clientRef ?? metaOrg, customerId, subscriptionId },
    db,
  );
  if (!organizationId) return 'no matching organization; ignored';
  if (!subscriptionId) return 'checkout without a subscription; ignored';

  // Make sure the customer id is on the row (first purchase).
  if (customerId) {
    await db.subscription.updateMany({
      where: { organizationId, stripeCustomerId: null },
      data: { stripeCustomerId: customerId },
    });
  }

  const stripeSub = await deps.gateway.getSubscription(subscriptionId);
  await applyStripeSubscription(
    {
      organizationId,
      stripeSubscription: stripeSub,
      config: deps.config,
      reason: 'checkout_completed',
    },
    db,
  );
  await recordAudit(
    {
      organizationId,
      actorType: 'SYSTEM',
      action: 'billing.checkout.completed',
      targetType: 'subscription',
      metadata: { subscriptionId },
    },
    db,
  );
  return `subscription ${subscriptionId} applied`;
}

async function handleSubscriptionUpsert(
  sub: StripeSubscription,
  deps: WebhookDeps,
  db: Db,
): Promise<string> {
  const organizationId = await resolveOrgId(
    {
      organizationId: sub.metadata?.organizationId ?? null,
      customerId: sub.customer,
      subscriptionId: sub.id,
    },
    db,
  );
  if (!organizationId) return `no org for subscription ${sub.id}; ignored`;
  await applyStripeSubscription(
    { organizationId, stripeSubscription: sub, config: deps.config, reason: 'subscription_event' },
    db,
  );
  return `subscription ${sub.id} → ${sub.status}`;
}

async function handleSubscriptionDeleted(sub: StripeSubscription, db: Db): Promise<string> {
  const organizationId = await resolveOrgId(
    { customerId: sub.customer, subscriptionId: sub.id },
    db,
  );
  if (!organizationId) return `no org for subscription ${sub.id}; ignored`;
  await downgradeToFree({ organizationId, reason: 'stripe_subscription_deleted' }, db);
  return `org ${organizationId} downgraded to FREE`;
}

async function handleInvoiceEvent(type: string, invoice: StripeInvoice, db: Db): Promise<string> {
  const organizationId = await resolveOrgId(
    { customerId: invoice.customer, subscriptionId: invoice.subscription ?? null },
    db,
  );
  if (!organizationId) return `no org for invoice ${invoice.id}; ignored`;
  await upsertInvoiceFromStripe({ organizationId, invoice }, db);

  if (type === 'invoice.payment_failed') {
    await recordAudit(
      {
        organizationId,
        actorType: 'SYSTEM',
        action: 'billing.invoice.payment_failed',
        targetType: 'invoice',
        targetId: invoice.id,
        metadata: { amountDue: invoice.amount_due, currency: invoice.currency },
      },
      db,
    );
    // Surface it in-app for the owner (never throws; idempotent on dedupeKey).
    await createNotification(
      {
        organizationId,
        kind: 'billing.payment_failed',
        level: 'WARNING',
        title: 'Payment failed',
        body: 'A subscription payment could not be collected. Update your card in the billing portal to keep your plan — access continues for a short grace period.',
        linkPath: '/app/billing',
        dedupeKey: `billing-payment-failed:${invoice.id}`,
        sourceType: 'invoice',
        sourceId: invoice.id,
      },
      db,
    );
  } else if (type === 'invoice.payment_succeeded' || type === 'invoice.paid') {
    await createNotification(
      {
        organizationId,
        kind: 'billing.payment_recovered',
        level: 'INFO',
        title: 'Payment received',
        body: 'Your subscription payment went through. Thanks!',
        linkPath: '/app/billing',
        dedupeKey: `billing-payment-recovered:${invoice.id}`,
        sourceType: 'invoice',
        sourceId: invoice.id,
      },
      db,
    );
  }
  return `invoice ${invoice.id} (${type}) mirrored`;
}
