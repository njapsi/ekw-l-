/**
 * `usage.record` — the write side of metering. Call it *after* metered work
 * succeeds. It is idempotent: a repeated `idempotencyKey` is a no-op (so a
 * retried request or a re-run job never double-counts), and the per-period
 * `UsageCounter` is incremented in the same transaction as the append-only
 * `UsageRecord`.
 */
import { type Db, type UsageMeter, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { resolveEntitlements } from '../billing/entitlements.js';
import { runInTransaction } from '../db-tx.js';
import { type MeterKey, resolvePeriod } from './meters.js';

const log = createLogger('usage.record');

export interface RecordUsageInput {
  organizationId: string;
  meter: MeterKey;
  /** Units consumed. Must be > 0 or the call is a no-op. */
  quantity: number;
  /**
   * Stable key that dedupes this event. Include the subject id + a period tag
   * for anything that could legitimately recur (e.g. one crawl, one agent run).
   */
  idempotencyKey: string;
  actorId?: string | null;
  subjectType?: string;
  subjectId?: string;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordUsageResult {
  recorded: boolean;
  deduped: boolean;
  used: number;
  periodStart: Date;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export async function recordUsage(
  input: RecordUsageInput,
  db: Db = prisma,
): Promise<RecordUsageResult> {
  const quantity = Math.trunc(input.quantity);
  const sub = await db.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: { currentPeriodStart: true, currentPeriodEnd: true },
  });
  const period = resolvePeriod(sub);

  if (quantity <= 0) {
    return { recorded: false, deduped: false, used: 0, periodStart: period.periodStart };
  }

  const meter: UsageMeter = input.meter;
  const limitValue = await currentLimit(input.organizationId, input.meter, db);

  try {
    const used = await runInTransaction(db, async (tx) => {
      await tx.usageRecord.create({
        data: {
          organizationId: input.organizationId,
          meter,
          quantity: BigInt(quantity),
          periodStart: period.periodStart,
          actorId: input.actorId ?? null,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          costUsd: input.costUsd,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata as never,
        },
      });
      const counter = await tx.usageCounter.upsert({
        where: {
          organizationId_meter_periodStart: {
            organizationId: input.organizationId,
            meter,
            periodStart: period.periodStart,
          },
        },
        create: {
          organizationId: input.organizationId,
          meter,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          used: BigInt(quantity),
          limitValue: limitValue == null ? null : BigInt(limitValue),
        },
        update: {
          used: { increment: BigInt(quantity) },
          periodEnd: period.periodEnd,
          limitValue: limitValue == null ? null : BigInt(limitValue),
        },
      });
      return Number(counter.used);
    });
    return { recorded: true, deduped: false, used, periodStart: period.periodStart };
  } catch (err) {
    if (isUniqueViolation(err)) {
      log.debug({ idempotencyKey: input.idempotencyKey, meter }, 'usage event already recorded');
      const counter = await db.usageCounter.findUnique({
        where: {
          organizationId_meter_periodStart: {
            organizationId: input.organizationId,
            meter,
            periodStart: period.periodStart,
          },
        },
        select: { used: true },
      });
      return {
        recorded: false,
        deduped: true,
        used: counter ? Number(counter.used) : 0,
        periodStart: period.periodStart,
      };
    }
    throw err;
  }
}

async function currentLimit(
  organizationId: string,
  meter: MeterKey,
  db: Db,
): Promise<number | null> {
  try {
    const { limits } = await resolveEntitlements(organizationId, db);
    return limits[meter];
  } catch {
    return null;
  }
}
