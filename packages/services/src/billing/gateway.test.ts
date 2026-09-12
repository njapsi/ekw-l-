import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { loadBillingConfig } from './config.js';
import {
  type BillingGateway,
  NullBillingGateway,
  StripeHttpGateway,
  createBillingGateway,
  toFormBody,
} from './gateway.js';

const CONFIG = loadBillingConfig({
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('toFormBody', () => {
  it('flattens nested objects and arrays into Stripe bracket notation', () => {
    const form = toFormBody({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 2 }],
      metadata: { organizationId: 'org1' },
    });
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][price]')).toBe('price_1');
    expect(form.get('line_items[0][quantity]')).toBe('2');
    expect(form.get('metadata[organizationId]')).toBe('org1');
  });

  it('skips null / undefined', () => {
    const form = toFormBody({ a: 1, b: null, c: undefined });
    expect(form.has('b')).toBe(false);
    expect(form.has('c')).toBe(false);
  });
});

describe('StripeHttpGateway', () => {
  it('POSTs a form-encoded checkout session with a bearer token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }),
    );
    const gw = new StripeHttpGateway(CONFIG, { fetchImpl });
    const session = await gw.createCheckoutSession({
      customerId: 'cus_1',
      priceId: 'price_1',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/no',
    });
    expect(session.url).toBe('https://checkout.stripe.com/x');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_x');
    expect(init!.method).toBe('POST');
    expect(String(init!.body as string)).toContain('line_items%5B0%5D%5Bprice%5D=price_1');
  });

  it('updateSubscription fetches the current item id then swaps the price', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/subscriptions/sub_1') && calls.length === 1) {
        return jsonResponse({
          id: 'sub_1',
          status: 'active',
          customer: 'cus_1',
          cancel_at_period_end: false,
          canceled_at: null,
          current_period_start: 1,
          current_period_end: 2,
          trial_end: null,
          items: { data: [{ id: 'si_1', price: { id: 'price_old' } }] },
        });
      }
      return jsonResponse({
        id: 'sub_1',
        status: 'active',
        customer: 'cus_1',
        cancel_at_period_end: false,
        canceled_at: null,
        current_period_start: 1,
        current_period_end: 2,
        trial_end: null,
        items: { data: [{ id: 'si_1', price: { id: 'price_new' } }] },
      });
    });
    const gw = new StripeHttpGateway(CONFIG, { fetchImpl });
    const res = await gw.updateSubscription('sub_1', { priceId: 'price_new' });
    expect(res.items.data[0]!.price.id).toBe('price_new');
    expect(String(fetchImpl.mock.calls[1]![1]!.body as string)).toContain(
      'items%5B0%5D%5Bid%5D=si_1',
    );
  });

  it('maps a Stripe error response to an AppError (429 → rate_limited)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'Too many requests' } }, 429),
    );
    const gw = new StripeHttpGateway(CONFIG, { fetchImpl });
    await expect(gw.getSubscription('sub_x')).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'rate_limited',
    );
  });

  it('verifies the webhook signature before parsing', () => {
    const gw = new StripeHttpGateway(CONFIG, { fetchImpl: vi.fn() });
    expect(() => gw.parseWebhookEvent('{}', 'bad')).toThrow();
  });
});

describe('createBillingGateway / NullBillingGateway', () => {
  it('returns a NullBillingGateway when Stripe is not configured', () => {
    const gw = createBillingGateway(loadBillingConfig({}));
    expect(gw).toBeInstanceOf(NullBillingGateway);
    expect(gw.configured).toBe(false);
  });

  it('Null gateway: reads are empty, mutations throw provider_unavailable', async () => {
    const gw: BillingGateway = new NullBillingGateway();
    await expect(gw.listInvoices('cus_1')).resolves.toEqual([]);
    await expect(
      gw.createCheckoutSession({
        customerId: 'c',
        priceId: 'p',
        successUrl: 's',
        cancelUrl: 'x',
      }),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'provider_unavailable');
  });
});
