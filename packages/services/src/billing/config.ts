/**
 * Stripe configuration, read from the environment. Absent config is a valid
 * state: the app runs on the FREE plan for everyone and every mutating billing
 * call returns a clear "billing not configured" error (mirrors how the app
 * runs without an AI key).
 *
 * Stripe Price IDs live here (not in the plan catalog) so the same catalog code
 * runs in every environment and prices are never hard-coded in the app.
 */
import type { BillingInterval, BillingTier } from '@growth-agent/db';

export interface StripePriceMap {
  /** `${tier}:${interval}` → Stripe Price id. */
  [key: string]: string | undefined;
}

export interface BillingConfig {
  configured: boolean;
  secretKey: string | null;
  webhookSecret: string | null;
  apiBaseUrl: string;
  apiVersion: string;
  appUrl: string;
  prices: StripePriceMap;
}

export function priceKey(tier: BillingTier, interval: BillingInterval): string {
  return `${tier}:${interval}`;
}

const ENV_PRICE_VARS: Array<[BillingTier, BillingInterval, string]> = [
  ['CREATOR', 'MONTH', 'STRIPE_PRICE_CREATOR_MONTH'],
  ['CREATOR', 'YEAR', 'STRIPE_PRICE_CREATOR_YEAR'],
  ['PRO', 'MONTH', 'STRIPE_PRICE_PRO_MONTH'],
  ['PRO', 'YEAR', 'STRIPE_PRICE_PRO_YEAR'],
  ['AGENCY', 'MONTH', 'STRIPE_PRICE_AGENCY_MONTH'],
  ['AGENCY', 'YEAR', 'STRIPE_PRICE_AGENCY_YEAR'],
];

export function loadBillingConfig(
  env: Record<string, string | undefined> = process.env,
): BillingConfig {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() || null;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || null;
  const prices: StripePriceMap = {};
  for (const [tier, interval, varName] of ENV_PRICE_VARS) {
    const v = env[varName]?.trim();
    if (v) prices[priceKey(tier, interval)] = v;
  }
  return {
    configured: Boolean(secretKey),
    secretKey,
    webhookSecret,
    apiBaseUrl: env.STRIPE_API_BASE_URL?.trim() || 'https://api.stripe.com',
    apiVersion: env.STRIPE_API_VERSION?.trim() || '2024-06-20',
    appUrl: env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000',
    prices,
  };
}

/** Reverse lookup: which tier+interval does a Stripe Price id map to? */
export function tierForPrice(
  config: BillingConfig,
  stripePriceId: string,
): { tier: BillingTier; interval: BillingInterval } | null {
  for (const [key, value] of Object.entries(config.prices)) {
    if (value === stripePriceId) {
      const [tier, interval] = key.split(':') as [BillingTier, BillingInterval];
      return { tier, interval };
    }
  }
  return null;
}

export function priceIdFor(
  config: BillingConfig,
  tier: BillingTier,
  interval: BillingInterval,
): string | null {
  return config.prices[priceKey(tier, interval)] ?? null;
}
