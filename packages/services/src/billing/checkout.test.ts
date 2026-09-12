import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { openBillingPortal, startCheckout } from './checkout.js';
import { loadBillingConfig } from './config.js';
import type { BillingGateway } from './gateway.js';

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_CREATOR_MONTH: 'price_creator_m',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

function makeDb(sub?: Partial<Record<string, unknown>>) {
  const row: any = {
    id: 's1',
    organizationId: 'org1',
    tier: 'FREE',
    status: 'ACTIVE',
    interval: 'MONTH',
    seats: 1,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    ...sub,
  };
  const db: any = {
    _row: row,
    subscription: {
      findUnique: vi.fn(async () => row),
      create: vi.fn(async () => row),
      update: vi.fn(async ({ data }: any) => Object.assign(row, data)),
    },
    entitlement: { upsert: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

function gateway(over: Partial<BillingGateway> = {}): BillingGateway {
  return {
    configured: true,
    createCustomer: vi.fn(async () => ({ id: 'cus_new' })),
    createCheckoutSession: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout/x' })),
    createPortalSession: vi.fn(async () => ({ id: 'ps_1', url: 'https://portal/x' })),
    getSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    listInvoices: vi.fn(async () => []),
    parseWebhookEvent: vi.fn(),
    ...over,
  } as unknown as BillingGateway;
}

const base = { organizationId: 'org1', userId: 'u1', userEmail: 'a@b.co', orgName: 'Org' };

describe('startCheckout', () => {
  it('creates a customer (first time) and returns the Stripe checkout URL', async () => {
    const db = makeDb();
    const gw = gateway();
    const res = await startCheckout(
      { ...base, tier: 'CREATOR', interval: 'MONTH' },
      { gateway: gw, config: CONFIG, db: db as never },
    );
    expect(res.url).toBe('https://checkout/x');
    expect(gw.createCustomer).toHaveBeenCalledOnce();
    expect(db._row.stripeCustomerId).toBe('cus_new');
    const arg = (gw.createCheckoutSession as any).mock.calls[0][0];
    expect(arg.priceId).toBe('price_creator_m');
    expect(arg.successUrl).toContain('https://app.example.com/app/billing');
  });

  it('rejects a non-self-serve tier', async () => {
    const db = makeDb();
    await expect(
      startCheckout(
        { ...base, tier: 'ENTERPRISE', interval: 'MONTH' },
        { gateway: gateway(), config: CONFIG, db: db as never },
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });

  it('errors when no Stripe price is configured for the tier/interval', async () => {
    const db = makeDb();
    await expect(
      startCheckout(
        { ...base, tier: 'CREATOR', interval: 'YEAR' },
        { gateway: gateway(), config: CONFIG, db: db as never },
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'provider_unavailable');
  });

  it('errors when billing is not configured (null gateway)', async () => {
    const db = makeDb();
    const gw = gateway({ configured: false });
    await expect(
      startCheckout(
        { ...base, tier: 'CREATOR', interval: 'MONTH' },
        { gateway: gw, config: loadBillingConfig({}), db: db as never },
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'provider_unavailable');
  });
});

describe('openBillingPortal', () => {
  it('returns the portal URL for an org with a customer', async () => {
    const db = makeDb({ stripeCustomerId: 'cus_1' });
    const res = await openBillingPortal(
      { organizationId: 'org1', userId: 'u1' },
      { gateway: gateway(), config: CONFIG, db: db as never },
    );
    expect(res.url).toBe('https://portal/x');
  });

  it('refuses when the org has no billing account yet', async () => {
    const db = makeDb({ stripeCustomerId: null });
    await expect(
      openBillingPortal(
        { organizationId: 'org1', userId: 'u1' },
        { gateway: gateway(), config: CONFIG, db: db as never },
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });
});
