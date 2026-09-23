/**
 * The plan catalog — the single source of truth for plan definitions: display
 * price, per-meter limits, and feature flags. Master instruction, Phase 10:
 * "Do not hard-code prices throughout the application. Create
 * configuration-based plans." Every price / limit / feature the app shows or
 * enforces comes from here (or a per-org `Entitlement` override), never from a
 * literal at a call site.
 *
 * Money here is for *display only* and is quoted in whole USD. The actual
 * charge is whatever the linked Stripe Price says; Stripe is the source of
 * truth for money (ADR-0010 / ADR-0025). Stripe Price IDs are environment
 * config (`billing/config.ts`), not part of this catalog, so the same catalog
 * is used in every environment.
 */
import type { BillingInterval, BillingTier } from '@growth-agent/db';
import type { MeterKey } from '../usage/meters.js';

export type FeatureKey =
  | 'exports'
  | 'scheduledCrawls'
  | 'whiteLabelReports'
  | 'automationMode'
  | 'apiAccess'
  | 'prioritySupport'
  | 'sso';

/** `null` ⇒ unlimited for that meter. */
export type MeterLimits = Record<MeterKey, number | null>;

export interface PlanDefinition {
  tier: BillingTier;
  name: string;
  blurb: string;
  /** Sort order, cheapest → most expensive. */
  order: number;
  /** Display price in whole USD. `null` ⇒ "custom / contact sales". */
  priceUsd: { MONTH: number | null; YEAR: number | null };
  /** Can a customer self-serve checkout into this tier? FREE is the default
   *  (no checkout); ENTERPRISE is sales-assisted. */
  selfServe: boolean;
  limits: MeterLimits;
  features: Record<FeatureKey, boolean>;
}

const NO_FEATURES: Record<FeatureKey, boolean> = {
  exports: false,
  scheduledCrawls: false,
  whiteLabelReports: false,
  automationMode: false,
  apiAccess: false,
  prioritySupport: false,
  sso: false,
};

export const PLAN_CATALOG: Record<BillingTier, PlanDefinition> = {
  FREE: {
    tier: 'FREE',
    name: 'Free',
    blurb: 'Try it on one project.',
    order: 0,
    priceUsd: { MONTH: 0, YEAR: 0 },
    selfServe: false,
    limits: {
      AI_REQUESTS: 100,
      AI_TOKENS: 50_000,
      CRAWLS: 2,
      CRAWL_PAGES: 500,
      CONNECTED_ACCOUNTS: 1,
      REPORTS: 0,
      CONTENT_GENERATIONS: 10,
      SEATS: 1,
      TOOL_CALLS: 200,
      RESEARCH_CALLS: 0,
    },
    features: { ...NO_FEATURES },
  },
  CREATOR: {
    tier: 'CREATOR',
    name: 'Creator',
    blurb: 'For a solo creator or site owner.',
    order: 1,
    priceUsd: { MONTH: 29, YEAR: 290 },
    selfServe: true,
    limits: {
      AI_REQUESTS: 2_000,
      AI_TOKENS: 500_000,
      CRAWLS: 20,
      CRAWL_PAGES: 5_000,
      CONNECTED_ACCOUNTS: 3,
      REPORTS: 20,
      CONTENT_GENERATIONS: 150,
      SEATS: 2,
      TOOL_CALLS: 4_000,
      RESEARCH_CALLS: 25,
    },
    features: { ...NO_FEATURES, exports: true },
  },
  PRO: {
    tier: 'PRO',
    name: 'Pro',
    blurb: 'For a growing team.',
    order: 2,
    priceUsd: { MONTH: 99, YEAR: 990 },
    selfServe: true,
    limits: {
      AI_REQUESTS: 12_000,
      AI_TOKENS: 3_000_000,
      CRAWLS: 150,
      CRAWL_PAGES: 40_000,
      CONNECTED_ACCOUNTS: 10,
      REPORTS: 200,
      CONTENT_GENERATIONS: 1_000,
      SEATS: 5,
      TOOL_CALLS: 25_000,
      RESEARCH_CALLS: 150,
    },
    features: {
      ...NO_FEATURES,
      exports: true,
      scheduledCrawls: true,
      automationMode: true,
      prioritySupport: true,
    },
  },
  AGENCY: {
    tier: 'AGENCY',
    name: 'Agency',
    blurb: 'For agencies managing many properties.',
    order: 3,
    priceUsd: { MONTH: 299, YEAR: 2_990 },
    selfServe: true,
    limits: {
      AI_REQUESTS: 60_000,
      AI_TOKENS: 12_000_000,
      CRAWLS: 800,
      CRAWL_PAGES: 200_000,
      CONNECTED_ACCOUNTS: 40,
      REPORTS: 1_000,
      CONTENT_GENERATIONS: 5_000,
      SEATS: 15,
      TOOL_CALLS: 150_000,
      RESEARCH_CALLS: 750,
    },
    features: {
      ...NO_FEATURES,
      exports: true,
      scheduledCrawls: true,
      whiteLabelReports: true,
      automationMode: true,
      prioritySupport: true,
      apiAccess: true,
    },
  },
  ENTERPRISE: {
    tier: 'ENTERPRISE',
    name: 'Enterprise',
    blurb: 'Custom limits, SSO, SLA, invoicing.',
    order: 4,
    priceUsd: { MONTH: null, YEAR: null },
    selfServe: false,
    limits: {
      AI_REQUESTS: null,
      AI_TOKENS: null,
      CRAWLS: null,
      CRAWL_PAGES: null,
      CONNECTED_ACCOUNTS: null,
      REPORTS: null,
      CONTENT_GENERATIONS: null,
      SEATS: null,
      TOOL_CALLS: null,
      RESEARCH_CALLS: null,
    },
    features: {
      exports: true,
      scheduledCrawls: true,
      whiteLabelReports: true,
      automationMode: true,
      apiAccess: true,
      prioritySupport: true,
      sso: true,
    },
  },
};

export const BILLING_TIERS = Object.values(PLAN_CATALOG)
  .sort((a, b) => a.order - b.order)
  .map((p) => p.tier);

export function getPlan(tier: BillingTier): PlanDefinition {
  return PLAN_CATALOG[tier];
}

export function listPlans(): PlanDefinition[] {
  return [...Object.values(PLAN_CATALOG)].sort((a, b) => a.order - b.order);
}

/** Tiers a customer can self-serve checkout into. */
export function purchasableTiers(): BillingTier[] {
  return listPlans()
    .filter((p) => p.selfServe)
    .map((p) => p.tier);
}

export function isUpgrade(from: BillingTier, to: BillingTier): boolean {
  return getPlan(to).order > getPlan(from).order;
}

export function isDowngrade(from: BillingTier, to: BillingTier): boolean {
  return getPlan(to).order < getPlan(from).order;
}

/** Plan limit for a meter (`null` ⇒ unlimited). */
export function planLimit(tier: BillingTier, meter: MeterKey): number | null {
  return getPlan(tier).limits[meter];
}

export function planFeature(tier: BillingTier, feature: FeatureKey): boolean {
  return getPlan(tier).features[feature];
}

export function displayPrice(tier: BillingTier, interval: BillingInterval): string {
  const amount = getPlan(tier).priceUsd[interval];
  if (amount == null) return 'Custom';
  if (amount === 0) return 'Free';
  return `$${amount.toLocaleString('en-US')}/${interval === 'MONTH' ? 'mo' : 'yr'}`;
}
