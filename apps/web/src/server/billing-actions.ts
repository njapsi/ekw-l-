'use server';

import { revalidatePath } from 'next/cache';
import type { BillingInterval, BillingTier } from '@growth-agent/db';
import { billing, isAppError } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface BillingActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  /** A Stripe-hosted URL the browser should navigate to. */
  url?: string;
}

function toError(e: unknown): BillingActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

const TIERS: BillingTier[] = ['FREE', 'CREATOR', 'PRO', 'AGENCY', 'ENTERPRISE'];
const INTERVALS: BillingInterval[] = ['MONTH', 'YEAR'];

function parseTier(v: string): BillingTier {
  if ((TIERS as string[]).includes(v)) return v as BillingTier;
  throw new Error('bad tier');
}
function parseInterval(v: string): BillingInterval {
  return (INTERVALS as string[]).includes(v) ? (v as BillingInterval) : 'MONTH';
}

/** Every billing action requires `billing:manage` (OWNER only). The browser is
 *  never trusted for this — the check is here, server-side. */
export async function startCheckoutAction(
  tier: string,
  interval: string,
): Promise<BillingActionResult> {
  try {
    const { org, user } = await requirePermission('billing:manage');
    const ctx = billing.billingContextFromEnv();
    const { url } = await billing.startCheckout(
      {
        organizationId: org.id,
        userId: user.id,
        userEmail: user.email ?? undefined,
        orgName: org.name,
        tier: parseTier(tier),
        interval: parseInterval(interval),
      },
      { gateway: ctx.gateway, config: ctx.config },
    );
    return { ok: true, url };
  } catch (e) {
    return toError(e);
  }
}

export async function openBillingPortalAction(): Promise<BillingActionResult> {
  try {
    const { org, user } = await requirePermission('billing:manage');
    const ctx = billing.billingContextFromEnv();
    const { url } = await billing.openBillingPortal(
      { organizationId: org.id, userId: user.id },
      { gateway: ctx.gateway, config: ctx.config },
    );
    return { ok: true, url };
  } catch (e) {
    return toError(e);
  }
}

export async function changePlanAction(
  tier: string,
  interval: string,
): Promise<BillingActionResult> {
  try {
    const { org, user } = await requirePermission('billing:manage');
    const ctx = billing.billingContextFromEnv();
    const deps = { gateway: ctx.gateway, config: ctx.config };
    const res = await billing.changePlan(
      {
        organizationId: org.id,
        userId: user.id,
        tier: parseTier(tier),
        interval: parseInterval(interval),
      },
      deps,
    );
    if (res.kind === 'needs_checkout') {
      const { url } = await billing.startCheckout(
        {
          organizationId: org.id,
          userId: user.id,
          userEmail: user.email ?? undefined,
          orgName: org.name,
          tier: parseTier(tier),
          interval: parseInterval(interval),
        },
        deps,
      );
      return { ok: true, url };
    }
    revalidatePath('/app/billing');
    return { ok: true, message: `Plan changed to ${res.tier} (${res.interval.toLowerCase()}).` };
  } catch (e) {
    return toError(e);
  }
}

export async function cancelSubscriptionAction(): Promise<BillingActionResult> {
  try {
    const { org, user } = await requirePermission('billing:manage');
    const ctx = billing.billingContextFromEnv();
    const res = await billing.cancelSubscription(
      { organizationId: org.id, userId: user.id },
      { gateway: ctx.gateway, config: ctx.config },
    );
    revalidatePath('/app/billing');
    return {
      ok: true,
      message: res.cancelAtPeriodEnd
        ? `Subscription will end${res.endsAt ? ` on ${new Date(res.endsAt).toLocaleDateString()}` : ''}. You keep access until then.`
        : 'Subscription canceled.',
    };
  } catch (e) {
    return toError(e);
  }
}

export async function resumeSubscriptionAction(): Promise<BillingActionResult> {
  try {
    const { org, user } = await requirePermission('billing:manage');
    const ctx = billing.billingContextFromEnv();
    await billing.resumeSubscription(
      { organizationId: org.id, userId: user.id },
      { gateway: ctx.gateway, config: ctx.config },
    );
    revalidatePath('/app/billing');
    return { ok: true, message: 'Subscription resumed — it will renew as normal.' };
  } catch (e) {
    return toError(e);
  }
}
