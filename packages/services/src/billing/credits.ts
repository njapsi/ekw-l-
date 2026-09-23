/**
 * Credit ledger (Phase 13, §23/§24). A per-organization, per-meter balance
 * that adds to — never replaces — the plan's own usage allowance. Every
 * change is its own append-only `CreditTransaction` row with a
 * `balanceAfter` snapshot; there is no `balance` column anywhere for normal
 * code to decrement directly (master instruction: "never silently modify
 * historical usage events"). The running balance is always the
 * `balanceAfter` of the most recent transaction for that (org, meter) pair.
 *
 * Deliberately scoped to the ledger primitive, not a purchase/checkout
 * flow: no product surface today sells a one-time "credit pack" (Stripe
 * Checkout here is subscription-only, `gateway.ts::createCheckoutSession`
 * always `mode: 'subscription'`), so building a `PURCHASE` UI would be
 * speculative. What's real and valuable now is manual grants (a
 * support-driven bonus allowance) and metered consumption — both
 * implemented, audited, and race-safe.
 */
import { type Db, type UsageMeter, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { runInTransaction } from '../db-tx.js';
import { AppError } from '../errors.js';

export type CreditTransactionType = 'PURCHASE' | 'GRANT' | 'CONSUMPTION' | 'REFUND' | 'ADJUSTMENT' | 'EXPIRATION';

async function currentBalance(organizationId: string, meter: UsageMeter, db: Db): Promise<number> {
  // `createdAt` alone is not a safe "most recent" key: two transactions
  // written back-to-back (e.g. a grant immediately followed by a
  // consumption, as every `grantCredits`-then-`consumeCredits` caller does)
  // can land in the same millisecond — `TIMESTAMP(3)` has finite
  // resolution, and a stable sort over a tie preserves *insertion* order,
  // silently returning the OLDER of the two tied rows instead of the
  // newer one. Reproduced live: a test doing exactly that sequence
  // intermittently read the pre-consumption balance back. `id` (cuid) is
  // itself time-ordered and never ties, so it's a correct secondary sort
  // key regardless of `createdAt` precision.
  const last = await db.creditTransaction.findFirst({
    where: { organizationId, meter },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return last ? Number(last.balanceAfter) : 0;
}

export interface GrantCreditsInput {
  organizationId: string;
  meter: UsageMeter;
  amount: number;
  actorId: string;
  source?: string;
}

/** Add credits (a support grant, a purchase once one exists, a refund). */
export async function grantCredits(input: GrantCreditsInput, db: Db = prisma) {
  if (input.amount <= 0) throw AppError.validation('Grant amount must be positive.');
  return runInTransaction(db, async (tx) => {
    const balance = await currentBalance(input.organizationId, input.meter, tx);
    const balanceAfter = balance + Math.trunc(input.amount);
    const row = await tx.creditTransaction.create({
      data: {
        organizationId: input.organizationId,
        meter: input.meter,
        type: 'GRANT',
        amount: Math.trunc(input.amount),
        balanceAfter,
        source: input.source ?? null,
        actorId: input.actorId,
      },
    });
    await recordAudit(
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        action: 'billing.credit.granted',
        targetType: 'credit_transaction',
        targetId: row.id,
        metadata: { meter: input.meter, amount: input.amount, balanceAfter },
      },
      tx,
    );
    return row;
  });
}

export interface ConsumeCreditsInput {
  organizationId: string;
  meter: UsageMeter;
  amount: number;
  /** e.g. the `UsageRecord.idempotencyKey` this consumption is covering. */
  referenceId?: string;
}

/**
 * Spend credits atomically — an org's own money-shaped balance, so it gets
 * the same conditional-`updateMany`-style atomic claim usage reservations
 * do (`usage/reserve.ts`), just expressed over `CreditTransaction`'s
 * append-only shape instead of a `UsageCounter` row: read the current
 * balance and the just-inserted row's `balanceAfter` inside one
 * transaction, and only commit if the balance never went negative. Throws
 * `insufficient_credits` (surfaced as a normal `AppError`, not a
 * `UsageLimitError` — a credit shortfall is a different condition from a
 * plan-limit rejection) rather than allowing an overdraft.
 */
export async function consumeCredits(input: ConsumeCreditsInput, db: Db = prisma) {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) return null;
  return runInTransaction(db, async (tx) => {
    const balance = await currentBalance(input.organizationId, input.meter, tx);
    if (balance < amount) {
      throw new AppError(
        'validation_failed',
        `Insufficient ${input.meter.toLowerCase()} credits (${balance} available, ${amount} requested).`,
        { expose: true },
      );
    }
    const balanceAfter = balance - amount;
    return tx.creditTransaction.create({
      data: {
        organizationId: input.organizationId,
        meter: input.meter,
        type: 'CONSUMPTION',
        amount: -amount,
        balanceAfter,
        referenceId: input.referenceId ?? null,
      },
    });
  });
}

export async function getCreditBalance(organizationId: string, meter: UsageMeter, db: Db = prisma): Promise<number> {
  return currentBalance(organizationId, meter, db);
}

export async function listCreditTransactions(organizationId: string, meter?: UsageMeter, db: Db = prisma) {
  return db.creditTransaction.findMany({
    where: { organizationId, ...(meter ? { meter } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export interface AdjustCreditsInput {
  organizationId: string;
  meter: UsageMeter;
  /** Signed — positive adds, negative removes. */
  amount: number;
  actorId: string;
  reason: string;
}

/** A manual correction (§60 "manual billing adjustments require reason,
 *  actor, timestamp, amount, organization, reference"). Always audited. */
export async function adjustCredits(input: AdjustCreditsInput, db: Db = prisma) {
  if (!input.reason.trim()) throw AppError.validation('An adjustment requires a reason.');
  return runInTransaction(db, async (tx) => {
    const balance = await currentBalance(input.organizationId, input.meter, tx);
    const balanceAfter = balance + Math.trunc(input.amount);
    const row = await tx.creditTransaction.create({
      data: {
        organizationId: input.organizationId,
        meter: input.meter,
        type: 'ADJUSTMENT',
        amount: Math.trunc(input.amount),
        balanceAfter,
        source: input.reason,
        actorId: input.actorId,
      },
    });
    await recordAudit(
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        action: 'billing.credit.adjusted',
        targetType: 'credit_transaction',
        targetId: row.id,
        metadata: { meter: input.meter, amount: input.amount, balanceAfter, reason: input.reason },
      },
      tx,
    );
    return row;
  });
}
