/**
 * Read models for the usage dashboard, plus the self-healing rollup that
 * rebuilds `UsageCounter.used` from the append-only `UsageRecord` ledger, and
 * the gauge reconcilers (seats, connected accounts) which reflect a live count
 * rather than an accumulating total.
 */
import { type Db, type UsageMeter, prisma } from '@growth-agent/db';
import { resolveEntitlements } from '../billing/entitlements.js';
import {
  type BillingPeriod,
  type MeterKey,
  METERS,
  USAGE_METERS,
  resolvePeriod,
} from './meters.js';

export interface MeterUsage {
  meter: MeterKey;
  label: string;
  unit: string;
  kind: 'counter' | 'gauge';
  used: number;
  limit: number | null;
  unlimited: boolean;
  remaining: number;
  ratio: number;
  /** 'ok' < 0.8, 'warn' 0.8–1, 'over' ≥ 1. */
  state: 'ok' | 'warn' | 'over';
}

export interface UsageSummary {
  period: { start: string; end: string };
  meters: MeterUsage[];
}

function meterState(ratio: number, unlimited: boolean): MeterUsage['state'] {
  if (unlimited) return 'ok';
  if (ratio >= 1) return 'over';
  if (ratio >= 0.8) return 'warn';
  return 'ok';
}

export async function getUsageSummary(
  organizationId: string,
  db: Db = prisma,
): Promise<UsageSummary> {
  const { limits, currentPeriodStart, currentPeriodEnd } = await resolveEntitlements(
    organizationId,
    db,
  );
  const period = resolvePeriod({ currentPeriodStart, currentPeriodEnd });

  const counters = await db.usageCounter.findMany({
    where: { organizationId, periodStart: period.periodStart },
  });
  const usedByMeter = new Map<string, number>();
  for (const c of counters) usedByMeter.set(c.meter, Number(c.used));

  // Gauges reflect current reality even if no counter row exists yet.
  const [seatCount, connectedCount] = await Promise.all([
    db.membership.count({ where: { organizationId, status: 'ACTIVE' } }),
    db.oAuthConnection.count({ where: { organizationId, status: 'ACTIVE' } }),
  ]);
  usedByMeter.set('SEATS', seatCount);
  usedByMeter.set('CONNECTED_ACCOUNTS', connectedCount);

  const meters: MeterUsage[] = USAGE_METERS.map((meter) => {
    const info = METERS[meter];
    const limit = limits[meter];
    const used = usedByMeter.get(meter) ?? 0;
    const unlimited = limit == null;
    const ratio = unlimited || limit === 0 ? (used > 0 && limit === 0 ? 1 : 0) : used / limit;
    return {
      meter,
      label: info.label,
      unit: info.unit,
      kind: info.kind,
      used,
      limit,
      unlimited,
      remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, (limit ?? 0) - used),
      ratio,
      state: meterState(ratio, unlimited),
    };
  });

  return {
    period: { start: period.periodStart.toISOString(), end: period.periodEnd.toISOString() },
    meters,
  };
}

/**
 * Recompute `UsageCounter.used` for the current period from `UsageRecord`.
 * Safe to run any time; used by a nightly job and after a suspected drift.
 */
export async function refreshUsageCounters(
  organizationId: string,
  db: Db = prisma,
  period?: BillingPeriod,
): Promise<void> {
  const { limits, currentPeriodStart, currentPeriodEnd } = await resolveEntitlements(
    organizationId,
    db,
  );
  const p = period ?? resolvePeriod({ currentPeriodStart, currentPeriodEnd });

  // Each meter's rebuild reads and writes its own row — independent of every
  // other meter — so they run concurrently instead of one at a time.
  await Promise.all(
    USAGE_METERS.map(async (meter) => {
      const m: UsageMeter = meter;
      const agg = await db.usageRecord.aggregate({
        where: { organizationId, meter: m, periodStart: p.periodStart },
        _sum: { quantity: true },
      });
      const used = agg._sum.quantity ?? BigInt(0);
      const limit = limits[meter];
      await db.usageCounter.upsert({
        where: {
          organizationId_meter_periodStart: {
            organizationId,
            meter: m,
            periodStart: p.periodStart,
          },
        },
        create: {
          organizationId,
          meter: m,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          used,
          limitValue: limit == null ? null : BigInt(limit),
        },
        update: { used, periodEnd: p.periodEnd, limitValue: limit == null ? null : BigInt(limit) },
      });
    }),
  );
}
