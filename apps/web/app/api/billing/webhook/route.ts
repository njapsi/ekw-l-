import { billing, isAppError, observability } from '@growth-agent/services';
import { createLogger } from '@growth-agent/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api.billing.webhook');

/**
 * Stripe webhook receiver. Public (no session — Stripe is the caller); the
 * request is authenticated by its signature, verified inside
 * `billing.handleStripeWebhook`. Processing is idempotent: a redelivered event
 * id is recognised and skipped (see `billing/webhook.ts`).
 *
 * We read the raw body with `req.text()` so the signed payload is byte-exact.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');

  const ctx = billing.billingContextFromEnv();
  if (!ctx.gateway.configured) {
    // Nothing to verify against — acknowledge so Stripe doesn't hammer retries
    // at a deployment that isn't wired for billing.
    return Response.json({ received: true, note: 'billing not configured' }, { status: 200 });
  }

  try {
    const result = await billing.handleStripeWebhook(
      { rawBody, signature },
      { gateway: ctx.gateway, config: ctx.config },
    );
    return Response.json(result, { status: 200 });
  } catch (e) {
    // A bad signature is a client error; anything else is transient — return 4xx
    // for the former (no retry) and 5xx for the latter (Stripe retries).
    const badSignature =
      e instanceof billing.StripeSignatureError ||
      (isAppError(e) && e.code === 'provider_unavailable' && /signing secret/i.test(e.message));
    if (badSignature) {
      log.warn({ err: String(e) }, 'rejected webhook with bad signature');
      observability.recordWebhookSignatureFailure('stripe');
      return Response.json({ error: 'Invalid signature.' }, { status: 400 });
    }
    log.error({ err: String(e) }, 'webhook processing failed');
    return Response.json({ error: 'Webhook processing failed.' }, { status: 500 });
  }
}
