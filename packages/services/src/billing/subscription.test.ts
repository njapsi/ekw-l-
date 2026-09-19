import { describe, expect, it, vi } from 'vitest';
import { loadBillingConfig } from './config.js';
import type { StripeSubscription } from './gateway.js';
import {
  applyStripeSubscription,
  describeStatus,
  getBillingSummary,
  isEntitledStatus,
  mapStripeStatus,
} from './subscription.js';

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_PRO_MONTH: 'price_pro_m',
  STRIPE_PRICE_AGENCY_YEAR: 'price_agency_y',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

function makeDb(seed: Partial<Record<string, unknown>> = {}) {
  const sub: any = seed.noSub
    ? null
    : {
        id: 's1',
        organizationId: 'org1',
        tier: 'FREE',
        status: 'ACTIVE',
        interval: 'MONTH',
        seats: 1,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        trialEndsAt: null,
        ...seed,
      };
  let stored = sub;
  const db: any = {
    get _sub() {
      return stored;
    },
    subscription: {
      findUnique: vi.fn(async () => stored),
      create: vi.fn(async ({ data }: any) => {
        stored = { id: 's1', seats: 1, interval: 'MONTH', cancelAtPeriodEnd: false, ...data };
        return stored;
      }),
      update: vi.fn(async ({ data }: any) => {
        stored = { ...stored, ...data };
        return stored;
      }),
    },
    entitlement: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})) },
    invoice: { findMany: vi.fn(async () => []) },
    usageCounter: { findMany: vi.fn(async () => []) },
    usageRecord: { aggregate: vi.fn(async () => ({ _sum: { quantity: null } })) },
    membership: { count: vi.fn(async () => 1) },
    oAuthConnection: { count: vi.fn(async () => 0) },
    // WordPress sites also count as connected accounts (ADR-0051).
    wordPressSite: { count: vi.fn(async () => 0) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

function stripeSub(over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    canceled_at: null,
    current_period_start: 1_800_000_000,
    current_period_end: 1_802_000_000,
    trial_end: null,
    items: {
      data: [{ id: 'si_1', price: { id: 'price_pro_m', recurring: { interval: 'month' } } }],
    },
    ...over,
  };
}

describe('status mapping', () => {
  it('maps Stripe statuses and marks the entitled ones', () => {
    expect(mapStripeStatus('past_due')).toBe('PAST_DUE');
    expect(mapStripeStatus('weird')).toBe('INCOMPLETE');
    expect(isEntitledStatus('ACTIVE')).toBe(true);
    expect(isEntitledStatus('TRIALING')).toBe(true);
    expect(isEntitledStatus('CANCELED')).toBe(false);
    expect(describeStatus('PAST_DUE')).toMatch(/past due/i);
  });
});

describe('applyStripeSubscription', () => {
  it('resolves the tier + interval from the price id and syncs entitlements on a tier move', async () => {
    const db = makeDb();
    await applyStripeSubscription(
      { organizationId: 'org1', stripeSubscription: stripeSub(), config: CONFIG },
      db as never,
    );
    expect(db._sub).toMatchObject({
      tier: 'PRO',
      interval: 'MONTH',
      status: 'ACTIVE',
      stripeSubscriptionId: 'sub_1',
      stripePriceId: 'price_pro_m',
    });
    expect(db.entitlement.upsert).toHaveBeenCalled();
  });

  it('an unknown price keeps the current tier (never guesses)', async () => {
    const db = makeDb({ tier: 'CREATOR' });
    await applyStripeSubscription(
      {
        organizationId: 'org1',
        stripeSubscription: stripeSub({
          items: { data: [{ id: 'si', price: { id: 'price_unknown' } }] },
        }),
        config: CONFIG,
      },
      db as never,
    );
    expect(db._sub.tier).toBe('CREATOR');
  });

  it('a canceled Stripe subscription drops the mirror to FREE', async () => {
    const db = makeDb({ tier: 'PRO' });
    await applyStripeSubscription(
      {
        organizationId: 'org1',
        stripeSubscription: stripeSub({ status: 'canceled' }),
        config: CONFIG,
      },
      db as never,
    );
    expect(db._sub.tier).toBe('FREE');
    expect(db._sub.status).toBe('CANCELED');
  });
});

describe('getBillingSummary', () => {
  it('creates a FREE subscription on first read and returns a full snapshot', async () => {
    const db = makeDb({ noSub: true });
    const s = await getBillingSummary('org1', db as never);
    expect(s.tier).toBe('FREE');
    expect(s.planName).toBe('Free');
    expect(s.plans.map((p) => p.tier)).toEqual(['FREE', 'CREATOR', 'PRO', 'AGENCY', 'ENTERPRISE']);
    expect(s.usage.meters.length).toBeGreaterThan(0);
    expect(s.invoices).toEqual([]);
  });
});
