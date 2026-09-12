import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import {
  addRevenueEntry,
  deleteRevenueEntry,
  getRevenueSummary,
  listRevenueEntries,
  updateRevenueEntry,
} from './revenue.js';

function fakeDb() {
  const rows: any[] = [];
  let seq = 0;
  return {
    rows,
    revenueEntry: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `r${++seq}`, createdAt: new Date(), deletedAt: null, ...data };
        rows.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              r.id === where.id &&
              r.organizationId === where.organizationId &&
              (where.deletedAt === null ? r.deletedAt === null : true),
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let out = rows.filter(
          (r) => r.organizationId === where.organizationId && r.deletedAt === null,
        );
        const ob = Array.isArray(orderBy) ? orderBy[0] : orderBy;
        if (ob?.periodStart === 'asc')
          out = [...out].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
        if (ob?.periodStart === 'desc')
          out = [...out].sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime());
        return out;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

const base = { organizationId: 'org_1', userId: 'u1' };
const entry = {
  channel: 'SPONSORSHIP' as const,
  source: 'Acme Co.',
  amount: 1200,
  currency: 'USD',
  periodStart: new Date('2026-01-01'),
  periodEnd: new Date('2026-01-31'),
};

describe('revenue tracking — user-entered only', () => {
  it('records an entry with the user as creator and audits it', async () => {
    const db = fakeDb();
    const row = await addRevenueEntry({ ...base, ...entry }, db as never);
    expect(row.createdById).toBe('u1');
    expect(Number(row.amount)).toBe(1200);
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it('rejects negative, non-finite, or implausibly large amounts', async () => {
    const db = fakeDb();
    for (const amount of [-1, Number.NaN, 2_000_000_000]) {
      await expect(addRevenueEntry({ ...base, ...entry, amount }, db as never)).rejects.toSatisfy(
        (e) => isAppError(e) && e.code === 'validation_failed',
      );
    }
  });

  it('rejects a period that ends before it starts and a bad currency', async () => {
    const db = fakeDb();
    await expect(
      addRevenueEntry(
        {
          ...base,
          ...entry,
          periodStart: new Date('2026-02-01'),
          periodEnd: new Date('2026-01-01'),
        },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
    await expect(
      addRevenueEntry({ ...base, ...entry, currency: 'US' }, db as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });

  it('delete is a soft delete — the row stays for history', async () => {
    const db = fakeDb();
    const row = await addRevenueEntry({ ...base, ...entry }, db as never);
    await deleteRevenueEntry({ ...base, entryId: row.id }, db as never);
    expect(db.rows[0].deletedAt).toBeInstanceOf(Date);
    expect(await listRevenueEntries('org_1', db as never)).toHaveLength(0);
  });

  it('is tenant-scoped', async () => {
    const db = fakeDb();
    const row = await addRevenueEntry({ ...base, ...entry }, db as never);
    await expect(
      updateRevenueEntry({ organizationId: 'org_2', userId: 'u9', entryId: row.id }, db as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });

  it('summary aggregates by currency, channel and calendar month (historical tracking)', async () => {
    const db = fakeDb();
    await addRevenueEntry({ ...base, ...entry }, db as never);
    await addRevenueEntry(
      {
        ...base,
        channel: 'AFFILIATE',
        source: 'Program X',
        amount: 300,
        currency: 'USD',
        periodStart: new Date('2026-02-01'),
        periodEnd: new Date('2026-02-28'),
      },
      db as never,
    );
    await addRevenueEntry(
      {
        ...base,
        channel: 'SPONSORSHIP',
        source: 'Euro deal',
        amount: 500,
        currency: 'EUR',
        periodStart: new Date('2026-02-10'),
        periodEnd: new Date('2026-02-20'),
      },
      db as never,
    );
    const s = await getRevenueSummary('org_1', db as never);
    expect(s.hasData).toBe(true);
    expect(s.byCurrency.USD).toBe(1500);
    expect(s.byCurrency.EUR).toBe(500);
    expect(s.byMonth.map((m) => m.month)).toEqual(['2026-01', '2026-02']);
    expect(s.byMonth[1]?.byCurrency).toEqual({ USD: 300, EUR: 500 });
    const sponsorship = s.byChannel.find((c) => c.channel === 'SPONSORSHIP');
    expect(sponsorship?.entryCount).toBe(2);
  });

  it('spreads a recurring entry across the months it covers — exact hand-computed estimate', async () => {
    const db = fakeDb();
    // 3 calendar months: Jan 15 - Mar 15 -> (0*12 + (2-0) + 1) = 3 months.
    await addRevenueEntry(
      {
        ...base,
        channel: 'SPONSORSHIP',
        source: 'Retainer',
        amount: 1200,
        currency: 'USD',
        periodStart: new Date('2026-01-15'),
        periodEnd: new Date('2026-03-15'),
        isRecurring: true,
      },
      db as never,
    );
    const s = await getRevenueSummary('org_1', db as never);
    expect(s.recurringMonthlyByCurrency.USD).toBe(400); // 1200 / 3 months, exact
  });

  it('sums recurringMonthlyByCurrency across multiple recurring entries and currencies', async () => {
    const db = fakeDb();
    await addRevenueEntry(
      {
        ...base,
        channel: 'SPONSORSHIP',
        source: 'Retainer A',
        amount: 600,
        currency: 'USD',
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-01-31'), // 1 month
        isRecurring: true,
      },
      db as never,
    );
    await addRevenueEntry(
      {
        ...base,
        channel: 'AFFILIATE',
        source: 'Program X',
        amount: 300,
        currency: 'USD',
        periodStart: new Date('2026-02-01'),
        periodEnd: new Date('2026-02-28'), // 1 month
        isRecurring: true,
      },
      db as never,
    );
    await addRevenueEntry(
      {
        ...base,
        channel: 'SPONSORSHIP',
        source: 'One-off',
        amount: 5000,
        currency: 'USD',
        periodStart: new Date('2026-03-01'),
        periodEnd: new Date('2026-03-01'),
        isRecurring: false, // never contributes to the recurring figure
      },
      db as never,
    );
    const s = await getRevenueSummary('org_1', db as never);
    expect(s.recurringMonthlyByCurrency.USD).toBe(900); // 600/1 + 300/1, not 5000
  });

  it('empty summary reports no data and invents nothing', async () => {
    const db = fakeDb();
    const s = await getRevenueSummary('org_1', db as never);
    expect(s).toMatchObject({ hasData: false, byCurrency: {}, byChannel: [], byMonth: [] });
  });
});
