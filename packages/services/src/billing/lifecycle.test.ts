/**
 * Phase 23 — the full subscription lifecycle, scripted end to end over a
 * stateful fake db + fake Stripe gateway: signup → checkout → creation →
 * upgrade → downgrade → cancel → resume → renewal → failed payment → recovery →
 * deletion. Asserts the mirror, the PLAN entitlements, and the entitled state
 * at every step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBillingConfig } from './config.js';
import type { BillingGateway, StripeEvent, StripeInvoice, StripeSubscription } from './gateway.js';
import { changePlan, cancelSubscription, resumeSubscription } from './plan-change.js';
import { startCheckout } from './checkout.js';
import { getPlan } from './plans.js';
import { getOrCreateSubscription, isEntitledStatus } from './subscription.js';
import { resolveEntitlements } from './entitlements.js';
import { handleStripeWebhook } from './webhook.js';

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  STRIPE_PRICE_CREATOR_MONTH: 'price_creator_m',
  STRIPE_PRICE_PRO_MONTH: 'price_pro_m',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

const PRICE_BY_TIER: Record<string, string> = {
  CREATOR: 'price_creator_m',
  PRO: 'price_pro_m',
};

// --- stateful fake db ---------------------------------------------------------

function makeWorld() {
  const subs = new Map<string, any>();
  const entitlements: any[] = [];
  const events = new Map<string, any>();
  const invoices = new Map<string, any>();
  const notifications: any[] = [];
  const audits: any[] = [];

  const db: any = {
    _subs: subs,
    _entitlements: entitlements,
    _notifications: notifications,
    _invoices: invoices,
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
        const row = {
          id: `s${subs.size + 1}`,
          seats: 1,
          interval: 'MONTH',
          cancelAtPeriodEnd: false,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripePriceId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          canceledAt: null,
          trialEndsAt: null,
          ...data,
        };
        subs.set(data.organizationId, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const s = subs.get(where.organizationId);
        Object.assign(s, data);
        return s;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const s = subs.get(where.organizationId);
        if (s && (where.stripeCustomerId === null ? s.stripeCustomerId == null : true)) {
          Object.assign(s, data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    entitlement: {
      findMany: vi.fn(async ({ where }: any) =>
        entitlements.filter((e) => e.organizationId === where.organizationId),
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.organizationId_key;
        const i = entitlements.findIndex(
          (e) => e.organizationId === key.organizationId && e.key === key.key,
        );
        if (i === -1) entitlements.push({ id: `ent${entitlements.length}`, ...create });
        else entitlements[i] = { ...entitlements[i], ...update };
        return {};
      }),
    },
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
    invoice: {
      upsert: vi.fn(async ({ where, create }: any) => {
        invoices.set(where.stripeInvoiceId, {
          ...(invoices.get(where.stripeInvoiceId) ?? {}),
          ...create,
        });
        return invoices.get(where.stripeInvoiceId);
      }),
    },
    notification: {
      upsert: vi.fn(async ({ where, create }: any) => {
        const existing = notifications.find((n) => n.dedupeKey === where.dedupeKey);
        if (existing) return existing;
        const row = { id: `n${notifications.length}`, emailedAt: null, ...create };
        notifications.push(row);
        return row;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `n${notifications.length}`, emailedAt: null, ...data };
        notifications.push(row);
        return row;
      }),
    },
    user: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async ({ data }: any) => void audits.push(data)) },
    usageCounter: { findUnique: vi.fn(async () => null) },
    membership: { count: vi.fn(async () => 1) },
    oAuthConnection: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return { db, subs, entitlements, notifications, invoices };
}

// --- fake gateway that reflects a mutable "Stripe truth" --------------------

function makeGateway(state: { sub: StripeSubscription | null }) {
  const nextEvent = { current: null as StripeEvent | null };
  const gw: BillingGateway = {
    configured: true,
    createCustomer: vi.fn(async () => ({ id: 'cus_1' })),
    createCheckoutSession: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout/x' })),
    createPortalSession: vi.fn(async () => ({ id: 'ps_1', url: 'https://portal/x' })),
    getSubscription: vi.fn(async () => {
      if (!state.sub) throw new Error('no sub');
      return state.sub;
    }),
    updateSubscription: vi.fn(async (_id: string, patch: any) => {
      if (!state.sub) throw new Error('no sub');
      if (patch.priceId) {
        state.sub.items.data[0]!.price.id = patch.priceId;
      }
      if (typeof patch.cancelAtPeriodEnd === 'boolean') {
        state.sub.cancel_at_period_end = patch.cancelAtPeriodEnd;
      }
      return state.sub;
    }),
    cancelSubscription: vi.fn(async (_id: string, opts: any) => {
      if (!state.sub) throw new Error('no sub');
      if (opts?.atPeriodEnd) state.sub.cancel_at_period_end = true;
      else state.sub.status = 'canceled';
      return state.sub;
    }),
    listInvoices: vi.fn(async () => []),
    parseWebhookEvent: vi.fn(() => {
      if (!nextEvent.current) throw new Error('no event queued');
      return nextEvent.current;
    }),
  } as unknown as BillingGateway;
  return { gw, nextEvent };
}

function stripeSub(
  tier: 'CREATOR' | 'PRO',
  over: Partial<StripeSubscription> = {},
): StripeSubscription {
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
      data: [{ id: 'si_1', price: { id: PRICE_BY_TIER[tier]!, recurring: { interval: 'month' } } }],
    },
    metadata: { organizationId: 'org1' },
    ...over,
  };
}

const evt = (type: string, object: unknown, id: string): StripeEvent => ({
  id,
  type,
  created: 1_800_000_000,
  data: { object: object as Record<string, unknown> },
});

const ORG = 'org1';
let world: ReturnType<typeof makeWorld>;
let state: { sub: StripeSubscription | null };
let gw: BillingGateway;
let nextEvent: { current: StripeEvent | null };

beforeEach(() => {
  world = makeWorld();
  state = { sub: null };
  const g = makeGateway(state);
  gw = g.gw;
  nextEvent = g.nextEvent;
});

async function deliver(type: string, object: unknown, id: string) {
  nextEvent.current = evt(type, object, id);
  return handleStripeWebhook(
    { rawBody: '{}', signature: 'sig' },
    { gateway: gw, config: CONFIG, db: world.db },
  );
}

async function planLimitsFor(): Promise<Record<string, number | null>> {
  const { limits } = await resolveEntitlements(ORG, world.db);
  return limits;
}

describe('subscription lifecycle', () => {
  it('signup: a new org lazily gets a FREE mirror + FREE entitlements', async () => {
    const sub = await getOrCreateSubscription(ORG, world.db);
    expect(sub).toMatchObject({ tier: 'FREE', status: 'ACTIVE' });
    expect(await planLimitsFor()).toMatchObject({
      AI_REQUESTS: getPlan('FREE').limits.AI_REQUESTS,
    });
  });

  it('checkout: returns a Stripe URL and refuses non-self-serve tiers', async () => {
    const res = await startCheckout(
      { organizationId: ORG, userId: 'u1', tier: 'CREATOR', interval: 'MONTH' },
      { gateway: gw, config: CONFIG, db: world.db },
    );
    expect(res.url).toBe('https://checkout/x');
    await expect(
      startCheckout(
        { organizationId: ORG, userId: 'u1', tier: 'ENTERPRISE', interval: 'MONTH' },
        { gateway: gw, config: CONFIG, db: world.db },
      ),
    ).rejects.toThrow(/contact sales/i);
    await expect(
      startCheckout(
        { organizationId: ORG, userId: 'u1', tier: 'FREE', interval: 'MONTH' },
        { gateway: gw, config: CONFIG, db: world.db },
      ),
    ).rejects.toThrow(/cannot be purchased/i);
  });

  it('runs the full lifecycle and keeps the mirror + entitlements + entitled state correct', async () => {
    await getOrCreateSubscription(ORG, world.db);

    // 1) checkout.session.completed → subscription created on CREATOR
    state.sub = stripeSub('CREATOR');
    const r1 = await deliver(
      'checkout.session.completed',
      { customer: 'cus_1', subscription: 'sub_1', client_reference_id: ORG },
      'evt_checkout',
    );
    expect(r1.outcome).toBe('processed');
    let sub = world.subs.get(ORG);
    expect(sub).toMatchObject({ tier: 'CREATOR', status: 'ACTIVE', stripeSubscriptionId: 'sub_1' });
    expect((await planLimitsFor()).CRAWLS).toBe(getPlan('CREATOR').limits.CRAWLS);
    expect(isEntitledStatus(sub.status)).toBe(true);

    // 2) upgrade CREATOR → PRO (prorated)
    const up = await changePlan(
      { organizationId: ORG, userId: 'u1', tier: 'PRO', interval: 'MONTH' },
      { gateway: gw, config: CONFIG, db: world.db },
    );
    expect(up).toMatchObject({ kind: 'changed', tier: 'PRO' });
    expect((gw.updateSubscription as any).mock.calls[0][1]).toMatchObject({
      prorationBehavior: 'create_prorations',
    });
    expect(world.subs.get(ORG).tier).toBe('PRO');
    expect((await planLimitsFor()).CRAWLS).toBe(getPlan('PRO').limits.CRAWLS);

    // 3) downgrade PRO → CREATOR (no proration)
    const down = await changePlan(
      { organizationId: ORG, userId: 'u1', tier: 'CREATOR', interval: 'MONTH' },
      { gateway: gw, config: CONFIG, db: world.db },
    );
    expect(down).toMatchObject({ kind: 'changed', tier: 'CREATOR' });
    expect((gw.updateSubscription as any).mock.calls.at(-1)[1]).toMatchObject({
      prorationBehavior: 'none',
    });
    expect(world.subs.get(ORG).tier).toBe('CREATOR');

    // 4) cancel at period end — access kept
    const cancel = await cancelSubscription(
      { organizationId: ORG, userId: 'u1' },
      { gateway: gw, config: CONFIG, db: world.db },
    );
    expect(cancel.cancelAtPeriodEnd).toBe(true);
    expect(world.subs.get(ORG).cancelAtPeriodEnd).toBe(true);
    expect(isEntitledStatus(world.subs.get(ORG).status)).toBe(true);

    // 5) resume — clears the pending cancellation
    await resumeSubscription(
      { organizationId: ORG, userId: 'u1' },
      { gateway: gw, config: CONFIG, db: world.db },
    );
    expect(world.subs.get(ORG).cancelAtPeriodEnd).toBe(false);

    // 6) renewal — a new period arrives via customer.subscription.updated
    state.sub = stripeSub('CREATOR', {
      current_period_start: 1_802_000_000,
      current_period_end: 1_804_000_000,
    });
    await deliver('customer.subscription.updated', state.sub, 'evt_renew');
    expect(world.subs.get(ORG).currentPeriodEnd?.getTime()).toBe(1_804_000_000 * 1000);
    expect(world.subs.get(ORG).status).toBe('ACTIVE');

    // 7) failed payment → PAST_DUE (still entitled) + a WARNING notification
    state.sub = stripeSub('CREATOR', { status: 'past_due' });
    await deliver('customer.subscription.updated', state.sub, 'evt_pastdue');
    sub = world.subs.get(ORG);
    expect(sub.status).toBe('PAST_DUE');
    expect(isEntitledStatus(sub.status)).toBe(true);
    const inv: StripeInvoice = {
      id: 'in_1',
      customer: 'cus_1',
      subscription: 'sub_1',
      number: 'A-1',
      status: 'open',
      amount_due: 2900,
      amount_paid: 0,
      amount_remaining: 2900,
      currency: 'usd',
      hosted_invoice_url: null,
      invoice_pdf: null,
      period_start: null,
      period_end: null,
      created: 1_802_000_000,
    };
    await deliver('invoice.payment_failed', inv, 'evt_invfail');
    expect(world.notifications.some((n) => n.kind === 'billing.payment_failed')).toBe(true);

    // 8) recovery → back to ACTIVE + an INFO notification
    state.sub = stripeSub('CREATOR', { status: 'active' });
    await deliver('customer.subscription.updated', state.sub, 'evt_recover');
    await deliver(
      'invoice.payment_succeeded',
      { ...inv, status: 'paid', amount_paid: 2900 },
      'evt_invpaid',
    );
    expect(world.subs.get(ORG).status).toBe('ACTIVE');
    expect(world.notifications.some((n) => n.kind === 'billing.payment_recovered')).toBe(true);

    // 9) deletion → FREE + FREE entitlements
    await deliver('customer.subscription.deleted', stripeSub('CREATOR'), 'evt_deleted');
    sub = world.subs.get(ORG);
    expect(sub).toMatchObject({ tier: 'FREE', status: 'CANCELED', stripeSubscriptionId: null });
    expect((await planLimitsFor()).CRAWLS).toBe(getPlan('FREE').limits.CRAWLS);
  });

  it('a redelivered event id is deduped before any work', async () => {
    await getOrCreateSubscription(ORG, world.db);
    state.sub = stripeSub('CREATOR');
    const first = await deliver(
      'checkout.session.completed',
      { customer: 'cus_1', subscription: 'sub_1', client_reference_id: ORG },
      'evt_dup',
    );
    expect(first.outcome).toBe('processed');
    const second = await deliver(
      'checkout.session.completed',
      { customer: 'cus_1', subscription: 'sub_1', client_reference_id: ORG },
      'evt_dup',
    );
    expect(second.outcome).toBe('deduped');
  });
});
