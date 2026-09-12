/**
 * Phase 23 — subscription expiration. Two mechanisms cover the window between a
 * missed/late webhook and the truth:
 *  1. `resolvePeriod` falls back to the calendar month when the mirror's period
 *     is stale, so `usage.checkUsage` reads a fresh counter for the new period.
 *  2. the nightly `reconcileOrganization` re-pulls Stripe and re-applies it.
 * Plus the entitled-status matrix that gates product access.
 */
import { describe, expect, it, vi } from 'vitest';
import { calendarMonthPeriod, resolvePeriod } from '../usage/meters.js';
import { loadBillingConfig } from './config.js';
import type { BillingGateway, StripeSubscription } from './gateway.js';
import { reconcileOrganization } from './reconcile.js';
import { isEntitledStatus } from './subscription.js';

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_PRO_MONTH: 'price_pro_m',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

describe('entitled-status matrix', () => {
  it('keeps access only for ACTIVE / TRIALING / PAST_DUE', () => {
    expect(isEntitledStatus('ACTIVE')).toBe(true);
    expect(isEntitledStatus('TRIALING')).toBe(true);
    expect(isEntitledStatus('PAST_DUE')).toBe(true);
    for (const s of ['CANCELED', 'UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED', 'PAUSED'] as const) {
      expect(isEntitledStatus(s)).toBe(false);
    }
  });
});

describe('resolvePeriod — a stale mirror period does not freeze usage counters', () => {
  it('falls back to the calendar month when the stored period has already ended', () => {
    const past = {
      currentPeriodStart: new Date('2020-01-01T00:00:00Z'),
      currentPeriodEnd: new Date('2020-02-01T00:00:00Z'),
    };
    const now = new Date('2026-09-10T12:00:00Z');
    expect(resolvePeriod(past, now)).toEqual(calendarMonthPeriod(now));
  });

  it('uses the stored period while it is still current', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const live = {
      currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    };
    expect(resolvePeriod(live, now)).toEqual({
      periodStart: live.currentPeriodStart,
      periodEnd: live.currentPeriodEnd,
    });
  });
});

describe('reconcileOrganization — self-heals a stale mirror', () => {
  function makeDb(sub: any) {
    const db: any = {
      subscription: {
        findUnique: vi.fn(async () => sub),
        update: vi.fn(async ({ data }: any) => Object.assign(sub, data)),
        create: vi.fn(async () => sub),
      },
      entitlement: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
      notification: { upsert: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
      user: { findUnique: vi.fn(async () => null) },
      usageRecord: {
        findMany: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({ _sum: { quantity: null } })),
      },
      usageCounter: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (fn: any) => fn(db)),
    };
    return db;
  }

  it('flips a mirror that still says ACTIVE to CANCELED when Stripe says canceled', async () => {
    const sub = {
      id: 's1',
      organizationId: 'org1',
      tier: 'PRO',
      status: 'ACTIVE',
      interval: 'MONTH',
      seats: 1,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    };
    const db = makeDb(sub);
    const canceled: StripeSubscription = {
      id: 'sub_1',
      status: 'canceled',
      customer: 'cus_1',
      cancel_at_period_end: false,
      canceled_at: 1_800_000_000,
      current_period_start: 1_790_000_000,
      current_period_end: 1_792_000_000,
      trial_end: null,
      items: {
        data: [{ id: 'si_1', price: { id: 'price_pro_m', recurring: { interval: 'month' } } }],
      },
      metadata: { organizationId: 'org1' },
    };
    const gateway: BillingGateway = {
      configured: true,
      getSubscription: vi.fn(async () => canceled),
      createCustomer: vi.fn(),
      createCheckoutSession: vi.fn(),
      createPortalSession: vi.fn(),
      updateSubscription: vi.fn(),
      cancelSubscription: vi.fn(),
      listInvoices: vi.fn(async () => []),
      parseWebhookEvent: vi.fn(),
    } as unknown as BillingGateway;

    const res = await reconcileOrganization('org1', { gateway, config: CONFIG }, db);
    expect(res.reconciled).toBe(true);
    expect(sub.status).toBe('CANCELED');
    expect(sub.tier).toBe('FREE'); // a canceled Stripe sub maps the mirror to FREE
  });

  it('is a no-op (still rebuilds counters) for an org with no Stripe subscription', async () => {
    const sub = {
      organizationId: 'org1',
      tier: 'FREE',
      status: 'ACTIVE',
      stripeSubscriptionId: null,
    };
    const db = makeDb(sub);
    const gateway = { configured: true, getSubscription: vi.fn() } as unknown as BillingGateway;
    const res = await reconcileOrganization('org1', { gateway, config: CONFIG }, db);
    expect(res).toMatchObject({ reconciled: false, reason: 'no stripe subscription' });
    expect(gateway.getSubscription).not.toHaveBeenCalled();
  });
});
