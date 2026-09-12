/**
 * Ensure an org has a Stripe customer. The id is stored on the `Subscription`
 * row; we never store anything else about the customer (no card data — Stripe
 * holds all PCI scope, ADR-0010).
 */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import type { BillingGateway } from './gateway.js';
import { getOrCreateSubscription } from './subscription.js';

export async function ensureStripeCustomer(
  input: {
    organizationId: string;
    actorId: string;
    email?: string;
    orgName?: string;
  },
  gateway: BillingGateway,
  db: Db = prisma,
): Promise<string> {
  const sub = await getOrCreateSubscription(input.organizationId, db);
  if (sub.stripeCustomerId) return sub.stripeCustomerId;

  const customer = await gateway.createCustomer({
    email: input.email,
    name: input.orgName,
    organizationId: input.organizationId,
  });

  await db.subscription.update({
    where: { organizationId: input.organizationId },
    data: { stripeCustomerId: customer.id },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: 'billing.customer.created',
      targetType: 'subscription',
      targetId: sub.id,
      metadata: { stripeCustomerId: customer.id },
    },
    db,
  );
  return customer.id;
}
