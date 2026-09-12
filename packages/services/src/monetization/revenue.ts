/**
 * Revenue tracking — **user-entered only**. The engine never invents a figure.
 * Entries are soft-deleted so historical tracking survives a correction.
 */
import { type Db, type MonetizationChannel, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';

export interface RevenueEntryInput {
  channel: MonetizationChannel;
  source: string;
  amount: number;
  currency?: string;
  periodStart: Date;
  periodEnd: Date;
  isRecurring?: boolean;
  note?: string;
}

function validate(input: RevenueEntryInput) {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw AppError.validation('Amount must be a non-negative number.');
  }
  if (input.amount > 1_000_000_000) throw AppError.validation('Amount is implausibly large.');
  if (
    !(input.periodStart instanceof Date) ||
    Number.isNaN(input.periodStart.getTime()) ||
    Number.isNaN(input.periodEnd.getTime())
  ) {
    throw AppError.validation('Provide a valid period.');
  }
  if (input.periodEnd.getTime() < input.periodStart.getTime()) {
    throw AppError.validation('Period end must be on or after period start.');
  }
  const cur = (input.currency ?? 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw AppError.validation('Currency must be a 3-letter ISO code.');
  return cur;
}

export async function addRevenueEntry(
  input: { organizationId: string; userId: string } & RevenueEntryInput,
  db: Db = prisma,
) {
  const currency = validate(input);
  const entry = await db.revenueEntry.create({
    data: {
      organizationId: input.organizationId,
      createdById: input.userId,
      channel: input.channel,
      source: input.source.trim().slice(0, 200) || 'Revenue',
      amount: input.amount,
      currency,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      isRecurring: Boolean(input.isRecurring),
      note: input.note?.trim().slice(0, 1000) || null,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'monetization.revenue.added',
      targetType: 'revenue_entry',
      targetId: entry.id,
      metadata: { channel: input.channel, currency, isRecurring: Boolean(input.isRecurring) },
    },
    db,
  );
  return entry;
}

export async function updateRevenueEntry(
  input: { organizationId: string; userId: string; entryId: string } & Partial<RevenueEntryInput>,
  db: Db = prisma,
) {
  const existing = await db.revenueEntry.findFirst({
    where: { id: input.entryId, organizationId: input.organizationId, deletedAt: null },
  });
  if (!existing) throw AppError.notFound('Revenue entry');
  const merged: RevenueEntryInput = {
    channel: input.channel ?? existing.channel,
    source: input.source ?? existing.source,
    amount: input.amount ?? Number(existing.amount),
    currency: input.currency ?? existing.currency,
    periodStart: input.periodStart ?? existing.periodStart,
    periodEnd: input.periodEnd ?? existing.periodEnd,
    isRecurring: input.isRecurring ?? existing.isRecurring,
    note: input.note ?? existing.note ?? undefined,
  };
  const currency = validate(merged);
  const updated = await db.revenueEntry.update({
    where: { id: existing.id },
    data: {
      channel: merged.channel,
      source: merged.source.trim().slice(0, 200),
      amount: merged.amount,
      currency,
      periodStart: merged.periodStart,
      periodEnd: merged.periodEnd,
      isRecurring: Boolean(merged.isRecurring),
      note: merged.note?.trim().slice(0, 1000) || null,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'monetization.revenue.updated',
      targetType: 'revenue_entry',
      targetId: existing.id,
    },
    db,
  );
  return updated;
}

export async function deleteRevenueEntry(
  input: { organizationId: string; userId: string; entryId: string },
  db: Db = prisma,
) {
  const existing = await db.revenueEntry.findFirst({
    where: { id: input.entryId, organizationId: input.organizationId, deletedAt: null },
  });
  if (!existing) throw AppError.notFound('Revenue entry');
  await db.revenueEntry.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'monetization.revenue.deleted',
      targetType: 'revenue_entry',
      targetId: existing.id,
    },
    db,
  );
}

export async function listRevenueEntries(organizationId: string, db: Db = prisma) {
  return db.revenueEntry.findMany({
    where: { organizationId, deletedAt: null },
    orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
}

export interface RevenueSummary {
  hasData: boolean;
  byCurrency: Record<string, number>;
  byChannel: Array<{ channel: string; byCurrency: Record<string, number>; entryCount: number }>;
  /** Historical tracking: total per calendar month (by currency). */
  byMonth: Array<{ month: string; byCurrency: Record<string, number> }>;
  recurringMonthlyByCurrency: Record<string, number>;
}

export async function getRevenueSummary(
  organizationId: string,
  db: Db = prisma,
): Promise<RevenueSummary> {
  const rows = await db.revenueEntry.findMany({
    where: { organizationId, deletedAt: null },
    orderBy: { periodStart: 'asc' },
  });
  const byCurrency: Record<string, number> = {};
  const byChannelMap = new Map<
    string,
    { byCurrency: Record<string, number>; entryCount: number }
  >();
  const byMonthMap = new Map<string, Record<string, number>>();
  const recurringMonthlyByCurrency: Record<string, number> = {};

  for (const r of rows) {
    const amt = Number(r.amount);
    byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + amt;

    const ch = byChannelMap.get(r.channel) ?? { byCurrency: {}, entryCount: 0 };
    ch.byCurrency[r.currency] = (ch.byCurrency[r.currency] ?? 0) + amt;
    ch.entryCount++;
    byChannelMap.set(r.channel, ch);

    const month = r.periodStart.toISOString().slice(0, 7);
    const m = byMonthMap.get(month) ?? {};
    m[r.currency] = (m[r.currency] ?? 0) + amt;
    byMonthMap.set(month, m);

    if (r.isRecurring) {
      // Approx: spread the entry across the months it covers. UTC getters
      // are required here, matching `byMonth`'s `toISOString().slice(0, 7)`
      // a few lines up — a period boundary is a calendar date (typically
      // built from a date-only string), and the local-time getters
      // (`getFullYear`/`getMonth`) shift that instant onto the wrong
      // calendar day (and sometimes month/year) on any server whose
      // timezone is behind UTC, silently corrupting this estimate.
      const months = Math.max(
        1,
        (r.periodEnd.getUTCFullYear() - r.periodStart.getUTCFullYear()) * 12 +
          (r.periodEnd.getUTCMonth() - r.periodStart.getUTCMonth()) +
          1,
      );
      recurringMonthlyByCurrency[r.currency] =
        (recurringMonthlyByCurrency[r.currency] ?? 0) + amt / months;
    }
  }

  return {
    hasData: rows.length > 0,
    byCurrency,
    byChannel: [...byChannelMap.entries()].map(([channel, v]) => ({ channel, ...v })),
    byMonth: [...byMonthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, byCurrency]) => ({ month, byCurrency })),
    recurringMonthlyByCurrency: Object.fromEntries(
      Object.entries(recurringMonthlyByCurrency).map(([k, v]) => [k, Number(v.toFixed(2))]),
    ),
  };
}
