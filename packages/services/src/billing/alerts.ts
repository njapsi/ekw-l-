/**
 * Billing alerts (Phase 13, §41/§84/§93): usage-threshold warnings and
 * trial-ending notices. Reuses the existing `notifications` module and its
 * idempotent-on-`dedupeKey` upsert exactly the way `subscription.ts`'s
 * past-due notice and `webhook.ts`'s payment-failed notice already do — no
 * new notification mechanism.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { createNotification } from '../notifications/index.js';
import { getUsageSummary } from '../usage/summary.js';
import { periodTag } from '../usage/meters.js';

const log = createLogger('billing.alerts');

/** Only counter-kind meters accumulate toward a "you're approaching your
 *  limit" warning that's meaningful to alert on once per threshold per
 *  period — a gauge (seats, connected accounts) is a live count a customer
 *  actively manages, not something that creeps up unnoticed over a billing
 *  period, so it's excluded here (unchanged from the existing dashboard,
 *  which already shows gauges' own ratio without a separate alert). */
const ALERT_THRESHOLDS = [1, 0.9, 0.8] as const; // checked highest-first so only the crossed threshold fires

/**
 * Check one organization's usage against 80/90/100% and send at most one
 * notification — the highest threshold newly crossed — idempotent per
 * (org, meter, threshold, period) so a repeated sweep never re-notifies for
 * the same crossing.
 */
export async function checkUsageAlertsForOrg(organizationId: string, db: Db = prisma): Promise<number> {
  const summary = await getUsageSummary(organizationId, db);
  let sent = 0;
  for (const m of summary.meters) {
    if (m.kind !== 'counter' || m.unlimited) continue;
    const crossed = ALERT_THRESHOLDS.find((t) => m.ratio >= t);
    if (!crossed) continue;
    const period = periodTag({ periodStart: new Date(summary.period.start), periodEnd: new Date(summary.period.end) });
    const pct = Math.round(crossed * 100);
    const id = await createNotification(
      {
        organizationId,
        kind: 'billing.usage_threshold',
        level: crossed >= 1 ? 'WARNING' : 'INFO',
        title: crossed >= 1 ? `${m.label} limit reached` : `${pct}% of your ${m.label.toLowerCase()} allowance used`,
        body:
          crossed >= 1
            ? `You've used ${m.used.toLocaleString('en-US')} of ${m.limit?.toLocaleString('en-US')} ${m.unit} this billing period. Upgrade your plan or wait for the next period to continue.`
            : `You've used ${m.used.toLocaleString('en-US')} of ${m.limit?.toLocaleString('en-US')} ${m.unit} (${pct}%) this billing period.`,
        linkPath: '/app/settings/usage',
        dedupeKey: `usage-alert:${organizationId}:${m.meter}:${pct}:${period}`,
        sourceType: 'usage_counter',
        sourceId: m.meter,
      },
      db,
    );
    if (id) sent += 1;
  }
  return sent;
}

export async function runUsageAlertsJob(db: Db = prisma): Promise<{ orgs: number; sent: number }> {
  const orgs = await db.organization.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  let sent = 0;
  for (const { id } of orgs) {
    try {
      sent += await checkUsageAlertsForOrg(id, db);
    } catch (err) {
      log.error({ organizationId: id, err: err instanceof Error ? err.message : String(err) }, 'usage alert check failed');
    }
  }
  return { orgs: orgs.length, sent };
}

/** How many days before `trialEndsAt` to send the one "your trial is
 *  ending" notice. */
const TRIAL_WARNING_DAYS = 3;

/**
 * Warn an org once, a few days before its trial ends, so a card-on-file
 * failure or a decision not to convert isn't a surprise (§41 "trial
 * ending"). Idempotent on a dedupe key derived from the exact
 * `trialEndsAt` timestamp, so a changed trial length (Stripe lets a trial
 * be extended) correctly re-arms the warning instead of treating it as
 * already sent. Does not "expire" a trial itself — Stripe's own webhook
 * (`customer.subscription.updated`, `trialing` → `active`/`past_due`)
 * already drives that transition through the existing subscription sync.
 */
export async function runTrialEndingSoonJob(db: Db = prisma): Promise<{ notified: number }> {
  const now = new Date();
  const horizon = new Date(now.getTime() + TRIAL_WARNING_DAYS * 24 * 60 * 60 * 1000);
  const trialing = await db.subscription.findMany({
    where: {
      status: 'TRIALING',
      trialEndsAt: { gte: now, lte: horizon },
    },
    select: { organizationId: true, trialEndsAt: true, tier: true },
  });
  let notified = 0;
  for (const sub of trialing) {
    if (!sub.trialEndsAt) continue;
    const id = await createNotification(
      {
        organizationId: sub.organizationId,
        kind: 'billing.trial_ending',
        level: 'INFO',
        title: 'Your trial is ending soon',
        body: `Your ${sub.tier} trial ends on ${sub.trialEndsAt.toLocaleDateString('en-US', { dateStyle: 'medium' } as never)}. Add a payment method in billing to keep your plan.`,
        linkPath: '/app/billing',
        dedupeKey: `trial-ending:${sub.organizationId}:${sub.trialEndsAt.toISOString()}`,
        sourceType: 'subscription',
      },
      db,
    );
    if (id) notified += 1;
  }
  return { notified };
}
