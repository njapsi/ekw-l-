/**
 * Entitlement resolution. An org's effective limits + feature flags are the
 * plan-catalog defaults for its current tier, overlaid with any per-org
 * `Entitlement` rows whose `source` is `OVERRIDE` / `PROMO` (support-granted
 * exceptions). `usage.check` reads the resolved limits; feature gates read the
 * resolved features.
 *
 * PLAN-source rows are materialised from the catalog on every plan change
 * (`syncPlanEntitlements`) so a single query answers "what can this org do".
 */
import { type Db, prisma } from '@growth-agent/db';
import type { BillingTier } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { runInTransaction } from '../db-tx.js';
import { AppError } from '../errors.js';
import { type MeterKey, USAGE_METERS, limitKey } from '../usage/meters.js';
import { type FeatureKey, getPlan } from './plans.js';

const FEATURE_KEYS: FeatureKey[] = [
  'exports',
  'scheduledCrawls',
  'whiteLabelReports',
  'automationMode',
  'apiAccess',
  'prioritySupport',
  'sso',
];

function featureKey(feature: FeatureKey): `feature:${FeatureKey}` {
  return `feature:${feature}`;
}

export interface ResolvedEntitlements {
  tier: BillingTier;
  /** meter → cap; `null` ⇒ unlimited. */
  limits: Record<MeterKey, number | null>;
  features: Record<FeatureKey, boolean>;
  /** Keys that were changed from the plan default by an override. */
  overridden: string[];
  /** The org's current billing period, from the same Subscription row read
   * to resolve `tier` — callers that also need the period (e.g. `usage.check`)
   * can reuse this instead of a second `Subscription` query. */
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

/**
 * Rewrite the PLAN-source entitlement rows for an org to match `tier`. Leaves
 * OVERRIDE / PROMO rows untouched. Idempotent.
 */
export async function syncPlanEntitlements(
  organizationId: string,
  tier: BillingTier,
  db: Db = prisma,
): Promise<void> {
  const plan = getPlan(tier);
  const desired: Array<{ key: string; limitValue: bigint | null; boolValue: boolean | null }> = [];
  for (const meter of USAGE_METERS) {
    const v = plan.limits[meter];
    desired.push({
      key: limitKey(meter),
      limitValue: v == null ? null : BigInt(v),
      boolValue: null,
    });
  }
  for (const f of FEATURE_KEYS) {
    desired.push({ key: featureKey(f), limitValue: null, boolValue: plan.features[f] });
  }

  await runInTransaction(db, async (tx) => {
    for (const row of desired) {
      await tx.entitlement.upsert({
        where: { organizationId_key: { organizationId, key: row.key } },
        create: {
          organizationId,
          key: row.key,
          limitValue: row.limitValue,
          boolValue: row.boolValue,
          source: 'PLAN',
        },
        update: {
          // Only refresh rows we own. An override for the same key is a
          // separate concern resolved at read time.
          limitValue: row.limitValue,
          boolValue: row.boolValue,
          source: 'PLAN',
        },
      });
    }
  });
}

function isLive(row: { expiresAt: Date | null }, now: Date): boolean {
  return row.expiresAt == null || row.expiresAt.getTime() > now.getTime();
}

/**
 * The effective limits + features for an org. Reads the org's tier from its
 * `Subscription` (defaulting to FREE) and overlays live override rows.
 */
export async function resolveEntitlements(
  organizationId: string,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<ResolvedEntitlements> {
  const [sub, rows] = await Promise.all([
    db.subscription.findUnique({
      where: { organizationId },
      select: { tier: true, currentPeriodStart: true, currentPeriodEnd: true },
    }),
    db.entitlement.findMany({ where: { organizationId } }),
  ]);
  const tier: BillingTier = sub?.tier ?? 'FREE';
  const plan = getPlan(tier);

  const limits = {} as Record<MeterKey, number | null>;
  for (const meter of USAGE_METERS) limits[meter] = plan.limits[meter];
  const features = { ...plan.features };
  const overridden: string[] = [];

  for (const row of rows) {
    if (row.source === 'PLAN' || !isLive(row, now)) continue;
    if (row.key.startsWith('limit:')) {
      const meter = row.key.slice('limit:'.length) as MeterKey;
      if ((USAGE_METERS as readonly string[]).includes(meter)) {
        limits[meter] = row.limitValue == null ? null : Number(row.limitValue);
        overridden.push(row.key);
      }
    } else if (row.key.startsWith('feature:')) {
      const f = row.key.slice('feature:'.length) as FeatureKey;
      if (FEATURE_KEYS.includes(f) && row.boolValue != null) {
        features[f] = row.boolValue;
        overridden.push(row.key);
      }
    }
  }

  return {
    tier,
    limits,
    features,
    overridden,
    currentPeriodStart: sub?.currentPeriodStart ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
  };
}

export async function getLimit(
  organizationId: string,
  meter: MeterKey,
  db: Db = prisma,
): Promise<number | null> {
  const { limits } = await resolveEntitlements(organizationId, db);
  return limits[meter];
}

export async function hasFeature(
  organizationId: string,
  feature: FeatureKey,
  db: Db = prisma,
): Promise<boolean> {
  const { features } = await resolveEntitlements(organizationId, db);
  return features[feature];
}

/** Support action: grant or change a per-org override. Audited. */
export async function setEntitlementOverride(
  input: {
    organizationId: string;
    actorId: string;
    key: string;
    limitValue?: number | null;
    boolValue?: boolean | null;
    source?: 'OVERRIDE' | 'PROMO';
    note?: string;
    expiresAt?: Date | null;
  },
  db: Db = prisma,
) {
  if (!input.key.startsWith('limit:') && !input.key.startsWith('feature:')) {
    throw AppError.validation('Entitlement key must start with "limit:" or "feature:".');
  }
  const row = await db.entitlement.upsert({
    where: { organizationId_key: { organizationId: input.organizationId, key: input.key } },
    create: {
      organizationId: input.organizationId,
      key: input.key,
      limitValue: input.limitValue == null ? null : BigInt(input.limitValue),
      boolValue: input.boolValue ?? null,
      source: input.source ?? 'OVERRIDE',
      note: input.note,
      createdById: input.actorId,
      expiresAt: input.expiresAt ?? null,
    },
    update: {
      limitValue: input.limitValue == null ? null : BigInt(input.limitValue),
      boolValue: input.boolValue ?? null,
      source: input.source ?? 'OVERRIDE',
      note: input.note,
      expiresAt: input.expiresAt ?? null,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: 'billing.entitlement.override_set',
      targetType: 'entitlement',
      targetId: row.id,
      metadata: {
        key: input.key,
        limitValue: input.limitValue ?? null,
        boolValue: input.boolValue ?? null,
      },
    },
    db,
  );
  return row;
}

export async function clearEntitlementOverride(
  input: { organizationId: string; actorId: string; key: string },
  db: Db = prisma,
) {
  const existing = await db.entitlement.findUnique({
    where: { organizationId_key: { organizationId: input.organizationId, key: input.key } },
  });
  if (!existing || existing.source === 'PLAN') return;
  await db.entitlement.delete({ where: { id: existing.id } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: 'billing.entitlement.override_cleared',
      targetType: 'entitlement',
      targetId: existing.id,
      metadata: { key: input.key },
    },
    db,
  );
}
