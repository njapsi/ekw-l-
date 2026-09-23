/**
 * Metered resources (master instruction, "Phase 10 — Billing" → "Track usage
 * for: AI requests, AI tokens, website crawls, crawl pages, connected accounts,
 * reports, content generation"). `SEATS` is tracked too for seat-based limits.
 *
 * A meter's *limit* is an entitlement (`limit:<METER>`), derived from the plan
 * catalog and enforced centrally here — never at a call site, never in the
 * browser.
 */
import type { UsageMeter } from '@growth-agent/db';

export const USAGE_METERS = [
  'AI_REQUESTS',
  'AI_TOKENS',
  'CRAWLS',
  'CRAWL_PAGES',
  'CONNECTED_ACCOUNTS',
  'REPORTS',
  'CONTENT_GENERATIONS',
  'SEATS',
  'TOOL_CALLS',
  'RESEARCH_CALLS',
] as const satisfies readonly UsageMeter[];

export type MeterKey = (typeof USAGE_METERS)[number];

export interface MeterInfo {
  meter: MeterKey;
  label: string;
  unit: string;
  /** A "gauge" meter reflects a current count (seats, connected accounts) and
   *  is reconciled from live rows; a "counter" meter accumulates over a billing
   *  period and resets each period. */
  kind: 'counter' | 'gauge';
  description: string;
}

export const METERS: Record<MeterKey, MeterInfo> = {
  AI_REQUESTS: {
    meter: 'AI_REQUESTS',
    label: 'AI requests',
    unit: 'requests',
    kind: 'counter',
    description: 'Model calls made by the agents on your behalf.',
  },
  AI_TOKENS: {
    meter: 'AI_TOKENS',
    label: 'AI tokens',
    unit: 'tokens',
    kind: 'counter',
    description: 'Prompt + completion tokens across all model calls.',
  },
  CRAWLS: {
    meter: 'CRAWLS',
    label: 'Website crawls',
    unit: 'crawls',
    kind: 'counter',
    description: 'Crawls started this billing period.',
  },
  CRAWL_PAGES: {
    meter: 'CRAWL_PAGES',
    label: 'Crawl pages',
    unit: 'pages',
    kind: 'counter',
    description: 'Pages fetched by the crawler this billing period.',
  },
  CONNECTED_ACCOUNTS: {
    meter: 'CONNECTED_ACCOUNTS',
    label: 'Connected accounts',
    unit: 'accounts',
    kind: 'gauge',
    description: 'Active YouTube / TikTok / Search Console connections.',
  },
  REPORTS: {
    meter: 'REPORTS',
    label: 'Report exports',
    unit: 'reports',
    kind: 'counter',
    description: 'Generated export files this billing period.',
  },
  CONTENT_GENERATIONS: {
    meter: 'CONTENT_GENERATIONS',
    label: 'Content generations',
    unit: 'generations',
    kind: 'counter',
    description: 'Content-repurposing deliverables generated this billing period.',
  },
  SEATS: {
    meter: 'SEATS',
    label: 'Seats',
    unit: 'seats',
    kind: 'gauge',
    description: 'Active members of the organization.',
  },
  TOOL_CALLS: {
    meter: 'TOOL_CALLS',
    label: 'Tool calls',
    unit: 'calls',
    kind: 'counter',
    description: 'Native, research and MCP tool invocations the agent runtime dispatched.',
  },
  RESEARCH_CALLS: {
    meter: 'RESEARCH_CALLS',
    label: 'Research calls',
    unit: 'fetches',
    kind: 'counter',
    description: 'External web pages fetched by a research project this billing period.',
  },
};

export function describeMeter(meter: MeterKey): MeterInfo {
  return METERS[meter];
}

export const GAUGE_METERS = USAGE_METERS.filter((m) => METERS[m].kind === 'gauge');

/** Entitlement key that holds this meter's cap. */
export function limitKey(meter: MeterKey): `limit:${MeterKey}` {
  return `limit:${meter}`;
}

/**
 * The billing period a usage event falls in. When the org has a Stripe
 * subscription we align to its current period; otherwise we bucket by calendar
 * month (UTC), which is also the fallback if the subscription period is stale.
 */
export interface BillingPeriod {
  periodStart: Date;
  periodEnd: Date;
}

export function calendarMonthPeriod(at: Date = new Date()): BillingPeriod {
  const periodStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { periodStart, periodEnd };
}

export function resolvePeriod(
  sub: { currentPeriodStart?: Date | null; currentPeriodEnd?: Date | null } | null | undefined,
  at: Date = new Date(),
): BillingPeriod {
  const start = sub?.currentPeriodStart ?? null;
  const end = sub?.currentPeriodEnd ?? null;
  if (start && end && start.getTime() <= at.getTime() && at.getTime() < end.getTime()) {
    return { periodStart: start, periodEnd: end };
  }
  return calendarMonthPeriod(at);
}

/** Stable string key for a period start (used in idempotency keys). */
export function periodTag(period: BillingPeriod): string {
  return period.periodStart.toISOString().slice(0, 10);
}
