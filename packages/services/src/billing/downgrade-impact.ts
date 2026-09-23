/**
 * Pre-downgrade impact check (Phase 13, §29): before a plan change takes a
 * feature or a usage allowance away, tell the customer exactly what breaks.
 * Read-only — `plan-change.ts::changePlan` still performs the actual
 * downgrade; this is what the UI calls first to show a warning and let the
 * user decide, rather than downgrading silently and finding out later.
 * Never deletes data on its own (master instruction / §29: "do not silently
 * delete customer data simply because a plan was downgraded") — every
 * historical row (content, reports, connections) survives a downgrade
 * regardless of the new plan's limits; only *new* usage is capped going
 * forward.
 */
import { type BillingTier, type Db, prisma } from '@growth-agent/db';
import { getPlan, type FeatureKey } from './plans.js';
import { getUsageSummary } from '../usage/summary.js';
import { getOrCreateSubscription } from './subscription.js';

export interface DowngradeMeterImpact {
  meter: string;
  label: string;
  currentUsage: number;
  currentLimit: number | null;
  newLimit: number | null;
  /** Already over the *new* plan's cap — new usage is blocked immediately;
   *  nothing already recorded is deleted or rolled back. */
  wouldExceedImmediately: boolean;
}

export interface DowngradeImpact {
  fromTier: BillingTier;
  toTier: BillingTier;
  meterImpacts: DowngradeMeterImpact[];
  featuresLost: FeatureKey[];
  /** Active members beyond the new plan's seat cap. Existing members are
   *  never removed automatically — this only flags that the org is over
   *  the new seat limit, same as any other over-limit meter. */
  seatsOverLimit: number;
  hasBlockingImpact: boolean;
}

export async function getDowngradeImpact(
  organizationId: string,
  toTier: BillingTier,
  db: Db = prisma,
): Promise<DowngradeImpact> {
  const [sub, summary] = await Promise.all([
    getOrCreateSubscription(organizationId, db),
    getUsageSummary(organizationId, db),
  ]);
  const fromTier = sub.tier;
  const targetPlan = getPlan(toTier);
  const currentPlan = getPlan(fromTier);

  const meterImpacts: DowngradeMeterImpact[] = summary.meters
    .map((m) => {
      const newLimit = targetPlan.limits[m.meter];
      return {
        meter: m.meter,
        label: m.label,
        currentUsage: m.used,
        currentLimit: m.limit,
        newLimit,
        wouldExceedImmediately: newLimit != null && m.used > newLimit,
      };
    })
    .filter((m) => m.wouldExceedImmediately || m.currentLimit !== m.newLimit);

  const featuresLost = (Object.keys(currentPlan.features) as FeatureKey[]).filter(
    (f) => currentPlan.features[f] && !targetPlan.features[f],
  );

  const seatMeter = meterImpacts.find((m) => m.meter === 'SEATS');
  const seatsOverLimit = seatMeter?.wouldExceedImmediately
    ? seatMeter.currentUsage - (seatMeter.newLimit ?? 0)
    : 0;

  return {
    fromTier,
    toTier,
    meterImpacts,
    featuresLost,
    seatsOverLimit,
    hasBlockingImpact: meterImpacts.some((m) => m.wouldExceedImmediately) || featuresLost.length > 0,
  };
}
