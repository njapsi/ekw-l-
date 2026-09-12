/**
 * `usage.check` — the read side of metering. Call it *before* doing metered
 * work (master instruction hard rule 11). It never mutates. Enforcement
 * (throwing) lives in `enforce.ts`; this returns a verdict the caller can also
 * use to render warnings.
 */
import { type Db, prisma } from '@growth-agent/db';
import { resolveEntitlements } from '../billing/entitlements.js';
import { METERS, type MeterKey, resolvePeriod } from './meters.js';

/**
 * Gauge meters (seats, connected accounts) reflect a *current* count, not an
 * accumulating period total, so the "used" figure is a live query.
 */
async function gaugeUsed(organizationId: string, meter: MeterKey, db: Db): Promise<number> {
  if (meter === 'SEATS') {
    return db.membership.count({ where: { organizationId, status: 'ACTIVE' } });
  }
  if (meter === 'CONNECTED_ACCOUNTS') {
    return db.oAuthConnection.count({ where: { organizationId, status: 'ACTIVE' } });
  }
  return 0;
}

export interface UsageVerdict {
  meter: MeterKey;
  /** No cap for this meter on the current plan. */
  unlimited: boolean;
  /** The cap (period total). Null when unlimited. */
  limit: number | null;
  /** Units already consumed this period. */
  used: number;
  /** `limit - used`, clamped at 0. `Infinity` when unlimited. */
  remaining: number;
  /** Would `used + amount` exceed the cap? */
  wouldExceed: boolean;
  /** `used / limit` in [0, ∞). 0 when unlimited. */
  ratio: number;
  /** Convenience: not unlimited and `used >= limit`. */
  atLimit: boolean;
}

export interface CheckUsageInput {
  organizationId: string;
  meter: MeterKey;
  /** Units the pending operation will consume. Default 1. */
  amount?: number;
}

export async function checkUsage(input: CheckUsageInput, db: Db = prisma): Promise<UsageVerdict> {
  const amount = Math.max(0, Math.trunc(input.amount ?? 1));
  const { limits, currentPeriodStart, currentPeriodEnd } = await resolveEntitlements(
    input.organizationId,
    db,
  );

  const limit = limits[input.meter];
  const period = resolvePeriod({ currentPeriodStart, currentPeriodEnd });

  let used: number;
  if (METERS[input.meter].kind === 'gauge') {
    used = await gaugeUsed(input.organizationId, input.meter, db);
  } else {
    const counter = await db.usageCounter.findUnique({
      where: {
        organizationId_meter_periodStart: {
          organizationId: input.organizationId,
          meter: input.meter,
          periodStart: period.periodStart,
        },
      },
      select: { used: true },
    });
    used = counter ? Number(counter.used) : 0;
  }

  if (limit == null) {
    return {
      meter: input.meter,
      unlimited: true,
      limit: null,
      used,
      remaining: Number.POSITIVE_INFINITY,
      wouldExceed: false,
      ratio: 0,
      atLimit: false,
    };
  }

  return {
    meter: input.meter,
    unlimited: false,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    wouldExceed: used + amount > limit,
    ratio: limit === 0 ? (used > 0 ? Number.POSITIVE_INFINITY : 0) : used / limit,
    atLimit: used >= limit,
  };
}
