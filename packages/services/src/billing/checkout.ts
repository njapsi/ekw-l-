/**
 * Checkout + billing portal. These produce a Stripe-hosted URL for the browser
 * to redirect to; the browser never carries a billing authorization decision —
 * the caller must already hold `billing:manage` (checked in the Server Action).
 */
import { type BillingInterval, type BillingTier, type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { type BillingConfig, priceIdFor } from './config.js';
import { ensureStripeCustomer } from './customers.js';
import type { BillingGateway } from './gateway.js';
import { getPlan } from './plans.js';
import { getOrCreateSubscription } from './subscription.js';

export interface CheckoutDeps {
  gateway: BillingGateway;
  config: BillingConfig;
  db?: Db;
}

export interface StartCheckoutInput {
  organizationId: string;
  userId: string;
  userEmail?: string;
  orgName?: string;
  tier: BillingTier;
  interval: BillingInterval;
  successPath?: string;
  cancelPath?: string;
}

export async function startCheckout(
  input: StartCheckoutInput,
  deps: CheckoutDeps,
): Promise<{ url: string }> {
  const db = deps.db ?? prisma;
  const plan = getPlan(input.tier);

  if (!plan.selfServe) {
    throw AppError.validation(
      input.tier === 'ENTERPRISE'
        ? 'Enterprise plans are set up with our team — contact sales.'
        : `The ${plan.name} plan cannot be purchased directly.`,
    );
  }
  if (!deps.gateway.configured) {
    throw new AppError('provider_unavailable', 'Billing is not configured on this deployment.');
  }

  const priceId = priceIdFor(deps.config, input.tier, input.interval);
  if (!priceId) {
    throw new AppError(
      'provider_unavailable',
      `No Stripe price is configured for ${plan.name} (${input.interval.toLowerCase()}).`,
      { expose: false },
    );
  }

  const customerId = await ensureStripeCustomer(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      email: input.userEmail,
      orgName: input.orgName,
    },
    deps.gateway,
    db,
  );

  const base = deps.config.appUrl.replace(/\/$/, '');
  const session = await deps.gateway.createCheckoutSession({
    customerId,
    priceId,
    successUrl: `${base}${input.successPath ?? '/app/billing?checkout=success'}`,
    cancelUrl: `${base}${input.cancelPath ?? '/app/billing?checkout=cancelled'}`,
    clientReferenceId: input.organizationId,
    metadata: { organizationId: input.organizationId, tier: input.tier, interval: input.interval },
  });

  if (!session.url) {
    throw new AppError('provider_unavailable', 'Stripe did not return a checkout URL.', {
      expose: false,
    });
  }

  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'billing.checkout.started',
      targetType: 'subscription',
      metadata: { tier: input.tier, interval: input.interval, sessionId: session.id },
    },
    db,
  );

  return { url: session.url };
}

export async function openBillingPortal(
  input: { organizationId: string; userId: string; returnPath?: string },
  deps: CheckoutDeps,
): Promise<{ url: string }> {
  const db = deps.db ?? prisma;
  if (!deps.gateway.configured) {
    throw new AppError('provider_unavailable', 'Billing is not configured on this deployment.');
  }
  const sub = await getOrCreateSubscription(input.organizationId, db);
  if (!sub.stripeCustomerId) {
    throw AppError.validation('This organization has no billing account yet. Choose a plan first.');
  }
  const base = deps.config.appUrl.replace(/\/$/, '');
  const session = await deps.gateway.createPortalSession({
    customerId: sub.stripeCustomerId,
    returnUrl: `${base}${input.returnPath ?? '/app/billing'}`,
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'billing.portal.opened',
      targetType: 'subscription',
      targetId: sub.id,
    },
    db,
  );
  return { url: session.url };
}
