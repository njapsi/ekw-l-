import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadBillingConfig } from './config.js';
import type { BillingGateway, StripeEvent, StripeSubscription } from './gateway.js';
import { handleStripeWebhook } from './webhook.js';

/**
 * Duplicate + concurrent Stripe webhook delivery against a real database
 * (Phase 15 QA). Self-skips without a DB — runs in CI.
 *
 * The guarantee: the `BillingEvent` row id **is** the Stripe event id, so a
 * redelivery hits the real unique constraint and is reported `deduped` before
 * any further work. The signature check is exercised separately in
 * `stripe-signature.test.ts`; here `parseWebhookEvent` is stubbed so the focus
 * is the ledger.
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
let reachable = false;

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  STRIPE_PRICE_PRO_MONTH: 'price_pro_m',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

const tag = `wh_${Date.now()}`;
let orgId = '';

function sub(): StripeSubscription {
  return {
    id: `sub_${tag}`,
    status: 'active',
    customer: `cus_${tag}`,
    cancel_at_period_end: false,
    canceled_at: null,
    current_period_start: 1_900_000_000,
    current_period_end: 1_902_000_000,
    trial_end: null,
    items: {
      data: [{ id: 'si_1', price: { id: 'price_pro_m', recurring: { interval: 'month' } } }],
    },
    metadata: { organizationId: orgId },
  };
}

function gateway(event: StripeEvent): BillingGateway {
  return {
    configured: true,
    createCustomer: vi.fn(),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    getSubscription: vi.fn(async () => sub()),
    updateSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    listInvoices: vi.fn(async () => []),
    parseWebhookEvent: vi.fn(() => event),
  } as unknown as BillingGateway;
}

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    return;
  }
  const user = await prisma.user.create({ data: { email: `${tag}@example.com` } });
  const org = await prisma.organization.create({
    data: {
      name: tag,
      slug: tag,
      memberships: { create: { userId: user.id, role: 'OWNER', status: 'ACTIVE' } },
      subscription: {
        create: {
          tier: 'FREE',
          status: 'ACTIVE',
          interval: 'MONTH',
          stripeCustomerId: `cus_${tag}`,
        },
      },
    },
  });
  orgId = org.id;
});

afterAll(async () => {
  if (prisma && reachable && orgId) {
    await prisma.billingEvent.deleteMany({ where: { id: { startsWith: `evt_${tag}` } } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { email: `${tag}@example.com` } });
  }
  await prisma?.$disconnect();
});

const maybe = () => (reachable ? it : it.skip);

function event(id: string): StripeEvent {
  return {
    id,
    type: 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    data: { object: sub() as unknown as Record<string, unknown> },
  };
}

describe('Stripe webhook delivery idempotency (integration)', () => {
  it('self-skips without a database', () => {
    expect(true).toBe(true);
  });

  maybe()('a redelivered event id is processed once, then deduped', async () => {
    const ev = event(`evt_${tag}_a`);
    const first = await handleStripeWebhook(
      { rawBody: '{}', signature: 'sig' },
      { gateway: gateway(ev), config: CONFIG, db: prisma! },
    );
    const second = await handleStripeWebhook(
      { rawBody: '{}', signature: 'sig' },
      { gateway: gateway(ev), config: CONFIG, db: prisma! },
    );
    expect(first.outcome).toBe('processed');
    expect(second.outcome).toBe('deduped');
    expect(await prisma!.billingEvent.count({ where: { id: ev.id } })).toBe(1);
  });

  maybe()(
    'two concurrent deliveries of the same event → one processed, one deduped, one row',
    async () => {
      const ev = event(`evt_${tag}_b`);
      const [r1, r2] = await Promise.all([
        handleStripeWebhook(
          { rawBody: '{}', signature: 'sig' },
          { gateway: gateway(ev), config: CONFIG, db: prisma! },
        ),
        handleStripeWebhook(
          { rawBody: '{}', signature: 'sig' },
          { gateway: gateway(ev), config: CONFIG, db: prisma! },
        ),
      ]);
      const outcomes = [r1.outcome, r2.outcome].sort();
      expect(outcomes).toEqual(['deduped', 'processed']);
      expect(await prisma!.billingEvent.count({ where: { id: ev.id } })).toBe(1);
    },
  );
});
