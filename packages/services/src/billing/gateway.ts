/**
 * The billing gateway boundary. Everything the app needs from Stripe goes
 * through this interface; the app never imports the Stripe SDK (ADR-0025 —
 * same "own the insulation layer" reasoning as ADR-0004 for AI). Two
 * implementations:
 *
 *  - `StripeHttpGateway` — talks to the Stripe REST API with `fetch` and
 *    form-encoded bodies; verifies webhooks with `stripe-signature.ts`. No SDK,
 *    no new dependency. `fetch` is injectable for tests.
 *  - `NullBillingGateway` — used when Stripe is not configured. Reads return
 *    empty; mutations throw `provider_unavailable`.
 */
import { AppError } from '../errors.js';
import type { BillingConfig } from './config.js';
import { verifyStripeSignature, type SignatureVerifyOptions } from './stripe-signature.js';

// --- Minimal shapes we consume from Stripe objects -------------------------

export interface StripeCustomer {
  id: string;
  email?: string | null;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer?: string | null;
  subscription?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export interface StripeSubscriptionItem {
  id: string;
  price: { id: string; recurring?: { interval?: string } | null };
  quantity?: number;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
  trial_end: number | null;
  items: { data: StripeSubscriptionItem[] };
  metadata?: Record<string, string> | null;
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  period_start: number | null;
  period_end: number | null;
  created: number;
  customer: string;
  subscription?: string | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
  request?: { idempotency_key?: string | null } | null;
}

// --- Interface ------------------------------------------------------------

export interface CreateCheckoutInput {
  customerId: string;
  priceId: string;
  quantity?: number;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId?: string;
  metadata?: Record<string, string>;
  trialDays?: number;
}

export interface UpdateSubscriptionInput {
  priceId?: string;
  quantity?: number;
  cancelAtPeriodEnd?: boolean;
  prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
  metadata?: Record<string, string>;
}

export interface BillingGateway {
  readonly configured: boolean;
  createCustomer(input: {
    email?: string;
    name?: string;
    organizationId: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCustomer>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<StripeCheckoutSession>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<StripePortalSession>;
  getSubscription(subscriptionId: string): Promise<StripeSubscription>;
  updateSubscription(
    subscriptionId: string,
    input: UpdateSubscriptionInput,
  ): Promise<StripeSubscription>;
  cancelSubscription(
    subscriptionId: string,
    input?: { atPeriodEnd?: boolean },
  ): Promise<StripeSubscription>;
  listInvoices(customerId: string, opts?: { limit?: number }): Promise<StripeInvoice[]>;
  /** Verify + parse a raw webhook body. Throws on a bad signature. */
  parseWebhookEvent(rawBody: string, signatureHeader: string | null): StripeEvent;
}

// --- form encoding (Stripe's bracket notation) --------------------------

function primitiveToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

export function toFormBody(
  obj: Record<string, unknown>,
  prefix = '',
  out: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          toFormBody(item as Record<string, unknown>, `${field}[${i}]`, out);
        } else {
          out.append(`${field}[${i}]`, primitiveToString(item));
        }
      });
    } else if (typeof value === 'object') {
      toFormBody(value as Record<string, unknown>, field, out);
    } else {
      out.append(field, primitiveToString(value));
    }
  }
  return out;
}

// --- Stripe REST implementation ----------------------------------------

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class StripeHttpGateway implements BillingGateway {
  readonly configured = true;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly webhookSecret: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly sigOpts?: SignatureVerifyOptions;

  constructor(
    config: BillingConfig,
    opts: { fetchImpl?: FetchLike; signatureOptions?: SignatureVerifyOptions } = {},
  ) {
    if (!config.secretKey) throw new Error('StripeHttpGateway requires a secret key.');
    this.secretKey = config.secretKey;
    this.baseUrl = config.apiBaseUrl.replace(/\/$/, '');
    this.apiVersion = config.apiVersion;
    this.webhookSecret = config.webhookSecret;
    this.sigOpts = opts.signatureOptions;
    const globalFetch = globalThis.fetch as unknown as FetchLike | undefined;
    const f = opts.fetchImpl ?? globalFetch;
    if (!f) throw new Error('No fetch implementation available for StripeHttpGateway.');
    this.fetchImpl = f;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.append(k, String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Stripe-Version': this.apiVersion,
    };
    let init: RequestInit = { method, headers };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init = { ...init, body: toFormBody(body ?? {}).toString() };
    }
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const message =
        (json as { error?: { message?: string } } | null)?.error?.message ??
        `Stripe API error ${res.status}`;
      const code = res.status === 429 ? 'rate_limited' : 'provider_unavailable';
      throw new AppError(code, `Billing provider error: ${message}`, { expose: false });
    }
    return json as T;
  }

  createCustomer(input: {
    email?: string;
    name?: string;
    organizationId: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCustomer> {
    return this.request<StripeCustomer>('POST', '/v1/customers', {
      email: input.email,
      name: input.name,
      metadata: { organizationId: input.organizationId, ...input.metadata },
    });
  }

  createCheckoutSession(input: CreateCheckoutInput): Promise<StripeCheckoutSession> {
    return this.request<StripeCheckoutSession>('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: input.customerId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReferenceId,
      allow_promotion_codes: true,
      line_items: [{ price: input.priceId, quantity: input.quantity ?? 1 }],
      subscription_data: input.trialDays
        ? { trial_period_days: input.trialDays, metadata: input.metadata }
        : input.metadata
          ? { metadata: input.metadata }
          : undefined,
      metadata: input.metadata,
    });
  }

  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<StripePortalSession> {
    return this.request<StripePortalSession>('POST', '/v1/billing_portal/sessions', {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
  }

  getSubscription(subscriptionId: string): Promise<StripeSubscription> {
    return this.request<StripeSubscription>('GET', `/v1/subscriptions/${subscriptionId}`);
  }

  async updateSubscription(
    subscriptionId: string,
    input: UpdateSubscriptionInput,
  ): Promise<StripeSubscription> {
    const body: Record<string, unknown> = {
      cancel_at_period_end: input.cancelAtPeriodEnd,
      proration_behavior: input.prorationBehavior,
      metadata: input.metadata,
    };
    if (input.priceId) {
      const current = await this.getSubscription(subscriptionId);
      const itemId = current.items.data[0]?.id;
      body.items = [{ id: itemId, price: input.priceId, quantity: input.quantity ?? 1 }];
    }
    return this.request<StripeSubscription>('POST', `/v1/subscriptions/${subscriptionId}`, body);
  }

  cancelSubscription(
    subscriptionId: string,
    input: { atPeriodEnd?: boolean } = {},
  ): Promise<StripeSubscription> {
    if (input.atPeriodEnd ?? true) {
      return this.request<StripeSubscription>('POST', `/v1/subscriptions/${subscriptionId}`, {
        cancel_at_period_end: true,
      });
    }
    return this.request<StripeSubscription>(
      'POST',
      `/v1/subscriptions/${subscriptionId}/cancel`,
      {},
    );
  }

  async listInvoices(customerId: string, opts: { limit?: number } = {}): Promise<StripeInvoice[]> {
    const res = await this.request<{ data: StripeInvoice[] }>('GET', '/v1/invoices', undefined, {
      customer: customerId,
      limit: opts.limit ?? 20,
    });
    return res.data ?? [];
  }

  parseWebhookEvent(rawBody: string, signatureHeader: string | null): StripeEvent {
    if (!this.webhookSecret) {
      throw new AppError('provider_unavailable', 'No webhook signing secret configured.', {
        expose: false,
      });
    }
    verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret, this.sigOpts);
    return JSON.parse(rawBody) as StripeEvent;
  }
}

// --- Null implementation ----------------------------------------------

export class NullBillingGateway implements BillingGateway {
  readonly configured = false;

  private err(): AppError {
    return new AppError(
      'provider_unavailable',
      'Billing is not configured on this deployment. Set STRIPE_SECRET_KEY to enable it.',
    );
  }

  createCustomer(): Promise<StripeCustomer> {
    return Promise.reject(this.err());
  }
  createCheckoutSession(): Promise<StripeCheckoutSession> {
    return Promise.reject(this.err());
  }
  createPortalSession(): Promise<StripePortalSession> {
    return Promise.reject(this.err());
  }
  getSubscription(): Promise<StripeSubscription> {
    return Promise.reject(this.err());
  }
  updateSubscription(): Promise<StripeSubscription> {
    return Promise.reject(this.err());
  }
  cancelSubscription(): Promise<StripeSubscription> {
    return Promise.reject(this.err());
  }
  listInvoices(): Promise<StripeInvoice[]> {
    return Promise.resolve([]);
  }
  parseWebhookEvent(): StripeEvent {
    throw this.err();
  }
}

export function createBillingGateway(
  config: BillingConfig,
  opts: { fetchImpl?: FetchLike; signatureOptions?: SignatureVerifyOptions } = {},
): BillingGateway {
  if (!config.configured || !config.secretKey) return new NullBillingGateway();
  return new StripeHttpGateway(config, opts);
}
