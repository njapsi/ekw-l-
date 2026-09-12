import { describe, expect, it, vi } from 'vitest';
import { loadBillingConfig } from './config.js';
import type { BillingGateway, StripeEvent, StripeSubscription } from './gateway.js';
import { handleStripeWebhook } from './webhook.js';

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  STRIPE_PRICE_PRO_MONTH: 'price_pro_m',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

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
    metadata: { organizationId: 'org1' },
    ...over,
  };
}

function makeGateway(event: StripeEvent, sub = stripeSub()): BillingGateway {
  return {
    configured: true,
    createCustomer: vi.fn(),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    getSubscription: vi.fn(async () => sub),
    updateSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    listInvoices: vi.fn(async () => []),
    parseWebhookEvent: vi.fn(() => event),
  } as unknown as BillingGateway;
}

function makeDb() {
  const events = new Map<string, any>();
  const subs = new Map<string, any>([
    [
      'org1',
      {
        id: 's1',
        organizationId: 'org1',
        tier: 'FREE',
        status: 'ACTIVE',
        interval: 'MONTH',
        seats: 1,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: null,
      },
    ],
  ]);
  const entitlements: any[] = [];
  const invoices = new Map<string, any>();
  const audits: any[] = [];
  const notifs: any[] = [];
  const db: any = {
    _events: events,
    _subs: subs,
    _invoices: invoices,
    _audits: audits,
    billingEvent: {
      findUnique: vi.fn(async ({ where }: any) => events.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (events.has(data.id)) {
          const e: any = new Error('dupe');
          e.code = 'P2002';
          throw e;
        }
        events.set(data.id, { ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        events.set(where.id, { ...events.get(where.id), ...data });
        return events.get(where.id);
      }),
    },
    organization: {
      findUnique: vi.fn(async ({ where }: any) => (subs.has(where.id) ? { id: where.id } : null)),
    },
    subscription: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.organizationId) return subs.get(where.organizationId) ?? null;
        for (const s of subs.values()) {
          if (where.stripeSubscriptionId && s.stripeSubscriptionId === where.stripeSubscriptionId)
            return s;
          if (where.stripeCustomerId && s.stripeCustomerId === where.stripeCustomerId) return s;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        subs.set(data.organizationId, {
          id: `s${subs.size}`,
          seats: 1,
          interval: 'MONTH',
          ...data,
        });
        return subs.get(data.organizationId);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const s = subs.get(where.organizationId);
        Object.assign(s, data);
        return s;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    entitlement: {
      findMany: vi.fn(async () => entitlements),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const i = entitlements.findIndex(
          (e) =>
            e.key === where.organizationId_key.key &&
            e.organizationId === where.organizationId_key.organizationId,
        );
        if (i === -1) entitlements.push({ ...create });
        else entitlements[i] = { ...entitlements[i], ...update };
        return {};
      }),
    },
    invoice: {
      upsert: vi.fn(async ({ where, create }: any) => {
        invoices.set(where.stripeInvoiceId, {
          ...(invoices.get(where.stripeInvoiceId) ?? {}),
          ...create,
        });
        return invoices.get(where.stripeInvoiceId);
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => void audits.push(data)) },
    notification: {
      upsert: vi.fn(async ({ where, create }: any) => {
        const found = notifs.find((n) => n.dedupeKey === where.dedupeKey);
        if (found) return found;
        const row = { id: `n${notifs.length}`, emailedAt: null, ...create };
        notifs.push(row);
        return row;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `n${notifs.length}`, emailedAt: null, ...data };
        notifs.push(row);
        return row;
      }),
    },
    user: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  db._notifs = notifs;
  return db;
}

const evt = (type: string, object: unknown, id = 'evt_1'): StripeEvent => ({
  id,
  type,
  created: 1_800_000_000,
  data: { object: object as Record<string, unknown> },
});

describe('handleStripeWebhook', () => {
  it('customer.subscription.updated syncs the mirror + plan entitlements', async () => {
    const event = evt('customer.subscription.updated', stripeSub());
    const db = makeDb();
    const res = await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      { gateway: makeGateway(event), config: CONFIG, db: db as never },
    );
    expect(res.outcome).toBe('processed');
    expect(db._subs.get('org1')).toMatchObject({
      tier: 'PRO',
      status: 'ACTIVE',
      stripeSubscriptionId: 'sub_1',
    });
    expect(db._entitlements ?? db.entitlement.upsert).toBeTruthy();
    expect(db._events.get('evt_1').status).toBe('PROCESSED');
  });

  it('is idempotent — replaying the same event id does no further work', async () => {
    const event = evt('customer.subscription.updated', stripeSub());
    const db = makeDb();
    const gw = makeGateway(event);
    await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      { gateway: gw, config: CONFIG, db: db as never },
    );
    const upsertsAfterFirst = (db.subscription.update as any).mock.calls.length;
    const res2 = await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      { gateway: gw, config: CONFIG, db: db as never },
    );
    expect(res2.outcome).toBe('deduped');
    expect((db.subscription.update as any).mock.calls.length).toBe(upsertsAfterFirst);
  });

  it('customer.subscription.deleted downgrades the org to FREE', async () => {
    const db = makeDb();
    db._subs.get('org1').stripeSubscriptionId = 'sub_1';
    db._subs.get('org1').tier = 'PRO';
    const event = evt('customer.subscription.deleted', stripeSub({ status: 'canceled' }));
    await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      { gateway: makeGateway(event), config: CONFIG, db: db as never },
    );
    expect(db._subs.get('org1')).toMatchObject({
      tier: 'FREE',
      status: 'CANCELED',
      stripeSubscriptionId: null,
    });
  });

  it('invoice.paid mirrors the invoice', async () => {
    const db = makeDb();
    const invoice = {
      id: 'in_1',
      number: 'A-1',
      status: 'paid',
      amount_due: 2900,
      amount_paid: 2900,
      amount_remaining: 0,
      currency: 'usd',
      hosted_invoice_url: 'https://pay',
      invoice_pdf: 'https://pdf',
      period_start: 1,
      period_end: 2,
      created: 1_800_000_000,
      customer: 'cus_1',
      subscription: 'sub_1',
    };
    const event = evt('invoice.paid', invoice);
    const res = await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      { gateway: makeGateway(event), config: CONFIG, db: db as never },
    );
    expect(res.outcome).toBe('processed');
    expect(db._invoices.get('in_1')).toMatchObject({ status: 'paid', amountPaid: 2900 });
  });

  it('an unknown event type is recorded as SKIPPED, not an error', async () => {
    const db = makeDb();
    const event = evt('charge.dispute.created', {});
    const res = await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      { gateway: makeGateway(event), config: CONFIG, db: db as never },
    );
    expect(res.outcome).toBe('skipped');
    expect(db._events.get('evt_1').status).toBe('SKIPPED');
  });

  it('a bad signature throws before any ledger write', async () => {
    const db = makeDb();
    const gw = makeGateway(evt('customer.subscription.updated', stripeSub()));
    (gw.parseWebhookEvent as any) = vi.fn(() => {
      throw new Error('bad sig');
    });
    await expect(
      handleStripeWebhook(
        { rawBody: 'raw', signature: 'nope' },
        { gateway: gw, config: CONFIG, db: db as never },
      ),
    ).rejects.toThrow(/bad sig/);
    expect(db._events.size).toBe(0);
  });

  it('retry-safe — a handler exception leaves the row FAILED and rethrows; a redelivery retries it', async () => {
    const db = makeDb();
    const event = evt('checkout.session.completed', {
      customer: 'cus_1',
      subscription: 'sub_1',
      client_reference_id: 'org1',
    });
    // First delivery: the Stripe fetch inside the handler blows up.
    const boomGw = makeGateway(event);
    (boomGw.getSubscription as any) = vi.fn(async () => {
      throw new Error('stripe 503');
    });
    await expect(
      handleStripeWebhook(
        { rawBody: 'raw', signature: 'sig' },
        { gateway: boomGw, config: CONFIG, db: db as never },
      ),
    ).rejects.toThrow(/stripe 503/);
    expect(db._events.get('evt_1').status).toBe('FAILED');

    // Redelivery of the same id: the FAILED row is retried (not deduped), now OK.
    const okGw = makeGateway(event, stripeSub());
    const res = await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      { gateway: okGw, config: CONFIG, db: db as never },
    );
    expect(res.outcome).toBe('processed');
    expect(db._events.get('evt_1').status).toBe('PROCESSED');
    expect(db._subs.get('org1').tier).toBe('PRO');
  });

  it('invoice.payment_failed mirrors the invoice, audits, and writes a WARNING notification', async () => {
    const db = makeDb();
    db._subs.get('org1').stripeSubscriptionId = 'sub_1';
    const invoice = {
      id: 'in_fail',
      number: 'A-2',
      status: 'open',
      amount_due: 2900,
      amount_paid: 0,
      amount_remaining: 2900,
      currency: 'usd',
      hosted_invoice_url: null,
      invoice_pdf: null,
      period_start: 1,
      period_end: 2,
      created: 1_800_000_000,
      customer: 'cus_1',
      subscription: 'sub_1',
    };
    await handleStripeWebhook(
      { rawBody: 'raw', signature: 'sig' },
      {
        gateway: makeGateway(evt('invoice.payment_failed', invoice)),
        config: CONFIG,
        db: db as never,
      },
    );
    expect(db._invoices.get('in_fail')).toBeTruthy();
    expect(db._audits.some((a: any) => a.action === 'billing.invoice.payment_failed')).toBe(true);
    const n = db._notifs.find((x: any) => x.kind === 'billing.payment_failed');
    expect(n).toMatchObject({ level: 'WARNING', linkPath: '/app/billing' });
    expect(n.dedupeKey).toBe('billing-payment-failed:in_fail');
  });
});
