/**
 * Atomic usage reservation (Phase 13, §13/§55/§56/§99/§110). The existing
 * `enforceUsage` → do work → `recordUsage` cycle has a real TOCTOU race:
 * `enforceUsage` only *reads* the counter, so N concurrent callers can each
 * see "under the limit" before any of them writes, and all N proceed —
 * overshooting the cap by up to N-1 units. That was an accepted, small gap
 * before this phase (most callers aren't hit with real concurrency); this
 * module closes it for callers that need a real guarantee, without touching
 * the existing `enforceUsage`/`recordUsage` pair or its many call sites.
 *
 * `reserveUsage` combines the check and the increment into ONE atomic
 * database operation: a conditional `updateMany` (`used <= limit - quantity`)
 * — the exact idempotent-claim pattern already proven in this codebase for
 * mission-task and research-project claiming (Phase 12) — rather than a
 * `SELECT ... FOR UPDATE` this sandbox has no live Postgres to verify raw SQL
 * against. Postgres evaluates an `UPDATE ... WHERE` clause against the row's
 * live value and performs the `SET` in one atomic per-row operation, so two
 * concurrent reservations against the same counter serialize correctly with
 * no explicit row lock required. If the claim's `WHERE` no longer matches
 * (someone else's reservation landed first and used up the remaining
 * capacity), `count` is 0 and the whole attempt is rejected — nothing is
 * written, matching `enforceUsage`'s existing "no side effect when blocked"
 * behavior.
 *
 * Idempotency is checked *before* the claim (a fast, non-atomic read) so a
 * retried reservation attempt is told what already happened without
 * re-claiming capacity — the append-only `UsageRecord` row for a given
 * `idempotencyKey` is only ever written once, immediately after its claim
 * succeeds, never before, so a rejected claim never needs a rollback.
 *
 * `releaseUsageReservation` is the "settle down" half of §55's reserve →
 * job runs → actual usage → settle model: when the real work consumed less
 * than what was reserved (e.g. 3 of 5 requested content-generation
 * deliverables actually completed), the caller releases the unused delta —
 * an append-only, idempotent, negative-quantity adjustment record, never a
 * rewrite of the original reservation (master instruction: "never silently
 * modify historical usage events").
 */
import { type Db, prisma } from '@growth-agent/db';
import { resolveEntitlements } from '../billing/entitlements.js';
import { runInTransaction } from '../db-tx.js';
import { UsageLimitError } from './enforce.js';
import { describeMeter, type MeterKey, resolvePeriod } from './meters.js';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export interface ReserveUsageInput {
  organizationId: string;
  meter: MeterKey;
  /** Units the pending operation will consume. Must be a known, positive
   *  quantity fixed *before* the work starts — this primitive is for
   *  exactly that case (§55 "for expensive asynchronous jobs... where
   *  necessary"), not for a meter like `AI_TOKENS` whose true size is only
   *  known after the call returns (that stays an exhaustion gate, ADR-0038,
   *  unchanged). */
  amount: number;
  /** Stable key for this exact reservation attempt — a retry (worker retry,
   *  double form submit) with the same key is a no-op, matching
   *  `recordUsage`'s existing idempotency contract. */
  idempotencyKey: string;
  actorId?: string | null;
  subjectType?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReserveUsageResult {
  ok: true;
  deduped: boolean;
  unlimited: boolean;
  used: number;
  limit: number | null;
  periodStart: Date;
}

export async function reserveUsage(
  input: ReserveUsageInput,
  db: Db = prisma,
): Promise<ReserveUsageResult> {
  const quantity = Math.max(1, Math.trunc(input.amount));
  const { limits, currentPeriodStart, currentPeriodEnd } = await resolveEntitlements(
    input.organizationId,
    db,
  );
  const limit = limits[input.meter];
  const period = resolvePeriod({ currentPeriodStart, currentPeriodEnd });
  const counterKey = {
    organizationId_meter_periodStart: {
      organizationId: input.organizationId,
      meter: input.meter,
      periodStart: period.periodStart,
    },
  };

  // Ensure the counter row exists *before* the claim transaction, as its
  // own separately-committed, idempotent step — never inside the same
  // transaction as the conditional claim below. A plain `create` guarded by
  // a caught unique-constraint violation, not an `upsert`: an `upsert`
  // against an *existing* row still writes to it (refreshing `periodEnd`/
  // `limitValue`), and if the surrounding transaction then has to roll back
  // (a *different* concurrent reservation's claim failed, unrelated to this
  // one), naively restoring that row to its pre-transaction snapshot would
  // discard every other transaction's legitimate `used` increment that
  // landed in between — a real bug this exact shape caused and a
  // concurrency test caught (see the comment on memory-db's `$transaction`
  // for the full trace). Doing this here, outside any transaction that can
  // fail, sidesteps it entirely: nothing below ever mutates this row except
  // the one atomic, conditional `updateMany`.
  if (limit != null) {
    try {
      await db.usageCounter.create({
        data: {
          organizationId: input.organizationId,
          meter: input.meter,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          used: BigInt(0),
          limitValue: BigInt(limit),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  return runInTransaction(db, async (tx) => {
    const already = await tx.usageRecord.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (already) {
      const counter = await tx.usageCounter.findUnique({ where: counterKey });
      return {
        ok: true,
        deduped: true,
        unlimited: limit == null,
        used: counter ? Number(counter.used) : quantity,
        limit,
        periodStart: period.periodStart,
      };
    }

    if (limit == null) {
      await tx.usageCounter.upsert({
        where: counterKey,
        create: {
          organizationId: input.organizationId,
          meter: input.meter,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          used: BigInt(quantity),
          limitValue: null,
        },
        update: { used: { increment: quantity }, periodEnd: period.periodEnd },
      });
      await tx.usageRecord.create({
        data: {
          organizationId: input.organizationId,
          meter: input.meter,
          quantity: BigInt(quantity),
          periodStart: period.periodStart,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId ?? null,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          metadata: { ...input.metadata, reservation: true } as never,
        },
      });
      return { ok: true, deduped: false, unlimited: true, used: -1, limit: null, periodStart: period.periodStart };
    }

    // The row is guaranteed to exist by the pre-transaction create above —
    // this is the only mutation of it inside the transaction.
    const claim = await tx.usageCounter.updateMany({
      where: {
        organizationId: input.organizationId,
        meter: input.meter,
        periodStart: period.periodStart,
        used: { lte: BigInt(limit - quantity) },
      },
      data: { used: { increment: quantity } },
    });

    if (claim.count === 0) {
      const counter = await tx.usageCounter.findUnique({ where: counterKey });
      const used = counter ? Number(counter.used) : 0;
      const info = describeMeter(input.meter);
      throw new UsageLimitError(
        {
          meter: input.meter,
          unlimited: false,
          limit,
          used,
          remaining: Math.max(0, limit - used),
          wouldExceed: true,
          ratio: limit === 0 ? (used > 0 ? Number.POSITIVE_INFINITY : 0) : used / limit,
          atLimit: used >= limit,
        },
        `You've reached your plan's ${info.label.toLowerCase()} limit ` +
          `(${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} ${info.unit}). ` +
          `Upgrade your plan or wait for the next billing period.`,
      );
    }

    // The claim landed — now durably record it. If a genuinely concurrent
    // caller reserved under the exact same idempotencyKey between our dedup
    // check above and here (a narrow window), the unique constraint catches
    // it; we've already double-incremented the counter in that vanishingly
    // rare case, so we correct it back down rather than leave it wrong.
    try {
      await tx.usageRecord.create({
        data: {
          organizationId: input.organizationId,
          meter: input.meter,
          quantity: BigInt(quantity),
          periodStart: period.periodStart,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId ?? null,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          metadata: { ...input.metadata, reservation: true } as never,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await tx.usageCounter.updateMany({
        where: { organizationId: input.organizationId, meter: input.meter, periodStart: period.periodStart },
        data: { used: { decrement: quantity } },
      });
      const counter = await tx.usageCounter.findUnique({ where: counterKey });
      return {
        ok: true,
        deduped: true,
        unlimited: false,
        used: counter ? Number(counter.used) : 0,
        limit,
        periodStart: period.periodStart,
      };
    }

    const settled = await tx.usageCounter.findUnique({ where: counterKey });
    return {
      ok: true,
      deduped: false,
      unlimited: false,
      used: settled ? Number(settled.used) : quantity,
      limit,
      periodStart: period.periodStart,
    };
  });
}

export interface ReleaseUsageInput {
  organizationId: string;
  meter: MeterKey;
  /** How many of the originally reserved units to give back — the delta
   *  between what was reserved and what the work actually consumed. */
  quantity: number;
  /** The idempotencyKey the original `reserveUsage` call used. */
  idempotencyKey: string;
  reason?: string;
}

/**
 * Give back part or all of a reservation the subsequent work didn't use —
 * a partial failure (some of N items succeeded), or a total failure (the
 * job never ran at all). Idempotent: releasing the same reservation twice
 * is a no-op the second time. Writes a negative-quantity `UsageRecord`
 * rather than editing the original — the ledger stays append-only.
 */
export async function releaseUsageReservation(
  input: ReleaseUsageInput,
  db: Db = prisma,
): Promise<void> {
  const quantity = Math.max(0, Math.trunc(input.quantity));
  if (quantity === 0) return;
  const releaseKey = `${input.idempotencyKey}:release`;

  await runInTransaction(db, async (tx) => {
    const original = await tx.usageRecord.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (!original) return; // nothing was ever reserved under this key

    try {
      await tx.usageRecord.create({
        data: {
          organizationId: input.organizationId,
          meter: input.meter,
          quantity: BigInt(-quantity),
          periodStart: original.periodStart,
          idempotencyKey: releaseKey,
          subjectType: original.subjectType,
          subjectId: original.subjectId,
          metadata: {
            release: true,
            reason: input.reason ?? 'reservation not fully used',
            originalIdempotencyKey: input.idempotencyKey,
          } as never,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return; // already released once
      throw err;
    }

    await tx.usageCounter.updateMany({
      where: {
        organizationId: input.organizationId,
        meter: input.meter,
        periodStart: original.periodStart,
      },
      data: { used: { decrement: quantity } },
    });
    // Never let a rebuild/rounding edge case push the counter negative.
    await tx.usageCounter.updateMany({
      where: {
        organizationId: input.organizationId,
        meter: input.meter,
        periodStart: original.periodStart,
        used: { lt: 0 },
      },
      data: { used: BigInt(0) },
    });
  });
}
