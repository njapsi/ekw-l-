import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { loadBillingConfig } from './config.js';
import type { BillingGateway, StripeSubscription } from './gateway.js';
import { cancelSubscription, changePlan, resumeSubscription } from './plan-change.js';

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_PRO_MONTH: 'price_pro_m',
  STRIPE_PRICE_AGENCY_MONTH: 'price_agency_m',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

function stripeSub(over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    canceled_at: null,
    current_period_start: 1,
    current_period_end: 1_802_000_000,
    trial_end: null,
    items: {
      data: [{ id: 'si_1', price: { id: 'price_pro_m', recurring: { interval: 'month' } } }],
    },
    metadata: { organizationId: 'org1' },
    ...over,
  };
}

function makeDb(row: Partial<Record<string, unknown>> = {}) {
  const sub: any = {
    id: 's1',
    organizationId: 'org1',
    tier: 'PRO',
    status: 'ACTIVE',
    interval: 'MONTH',
    seats: 1,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-10-01'),
    ...row,
  };
  const db: any = {
    _sub: sub,
    subscription: {
      findUnique: vi.fn(async () => sub),
      create: vi.fn(async () => sub),
      update: vi.fn(async ({ data }: any) => Object.assign(sub, data)),
    },
    entitlement: { upsert: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

function gateway(sub: StripeSubscription): BillingGateway {
  return {
    configured: true,
    createCustomer: vi.fn(),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    getSubscription: vi.fn(async () => sub),
    updateSubscription: vi.fn(async (_id: string, input: any) =>
      stripeSub({
        cancel_at_period_end: input.cancelAtPeriodEnd ?? sub.cancel_at_period_end,
        items: {
          data: [
            {
              id: 'si_1',
              price: {
                id: input.priceId ?? sub.items.data[0]!.price.id,
                recurring: { interval: 'month' },
              },
            },
          ],
        },
      }),
    ),
    cancelSubscription: vi.fn(async () => stripeSub({ cancel_at_period_end: true })),
    listInvoices: vi.fn(async () => []),
    parseWebhookEvent: vi.fn(),
  } as unknown as BillingGateway;
}

describe('changePlan', () => {
  it('upgrades an existing subscription at Stripe with prorations and syncs the mirror', async () => {
    const db = makeDb();
    const gw = gateway(stripeSub());
    const res = await changePlan(
      { organizationId: 'org1', userId: 'u1', tier: 'AGENCY', interval: 'MONTH' },
      { gateway: gw, config: CONFIG, db: db as never },
    );
    expect(res).toEqual({ kind: 'changed', tier: 'AGENCY', interval: 'MONTH' });
    const [, input] = (gw.updateSubscription as any).mock.calls[0];
    expect(input).toMatchObject({
      priceId: 'price_agency_m',
      prorationBehavior: 'create_prorations',
    });
    expect(db._sub.tier).toBe('AGENCY');
  });

  it('downgrade uses proration_behavior "none"', async () => {
    const db = makeDb({ tier: 'AGENCY' });
    const gw = gateway(stripeSub());
    await changePlan(
      { organizationId: 'org1', userId: 'u1', tier: 'PRO', interval: 'MONTH' },
      { gateway: gw, config: CONFIG, db: db as never },
    );
    expect((gw.updateSubscription as any).mock.calls[0][1].prorationBehavior).toBe('none');
  });

  it('with no Stripe subscription, returns needs_checkout', async () => {
    const db = makeDb({ stripeSubscriptionId: null, tier: 'FREE' });
    const res = await changePlan(
      { organizationId: 'org1', userId: 'u1', tier: 'PRO', interval: 'MONTH' },
      { gateway: gateway(stripeSub()), config: CONFIG, db: db as never },
    );
    expect(res.kind).toBe('needs_checkout');
  });

  it('rejects selecting the plan you are already on', async () => {
    const db = makeDb({ tier: 'PRO' });
    await expect(
      changePlan(
        { organizationId: 'org1', userId: 'u1', tier: 'PRO', interval: 'MONTH' },
        { gateway: gateway(stripeSub()), config: CONFIG, db: db as never },
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });
});

describe('cancel / resume', () => {
  it('cancelSubscription sets cancelAtPeriodEnd and keeps access until period end', async () => {
    const db = makeDb();
    const res = await cancelSubscription(
      { organizationId: 'org1', userId: 'u1' },
      { gateway: gateway(stripeSub()), config: CONFIG, db: db as never },
    );
    expect(res.cancelAtPeriodEnd).toBe(true);
    expect(db._sub.cancelAtPeriodEnd).toBe(true);
    expect(db._sub.tier).toBe('PRO'); // still entitled until it actually ends
  });

  it('resumeSubscription clears the pending cancellation', async () => {
    const db = makeDb({ cancelAtPeriodEnd: true });
    const gw = gateway(stripeSub({ cancel_at_period_end: true }));
    const res = await resumeSubscription(
      { organizationId: 'org1', userId: 'u1' },
      { gateway: gw, config: CONFIG, db: db as never },
    );
    expect(res.resumed).toBe(true);
    expect((gw.updateSubscription as any).mock.calls[0][1]).toEqual({ cancelAtPeriodEnd: false });
  });

  it('resume refuses when nothing is scheduled to cancel', async () => {
    const db = makeDb({ cancelAtPeriodEnd: false });
    await expect(
      resumeSubscription(
        { organizationId: 'org1', userId: 'u1' },
        { gateway: gateway(stripeSub()), config: CONFIG, db: db as never },
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });
});
