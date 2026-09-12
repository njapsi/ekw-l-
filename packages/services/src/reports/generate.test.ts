import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { sampleSnapshot } from './sample.js';

const enforceUsage = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));
const recordUsage = vi.fn((..._a: unknown[]): Promise<unknown> =>
  Promise.resolve({ recorded: true, deduped: false, used: 1 }),
);
const buildReportSnapshot = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));

vi.mock('../usage/enforce.js', () => ({
  enforceUsage: (...a: unknown[]) => enforceUsage(...a),
}));
vi.mock('../usage/record.js', () => ({
  recordUsage: (...a: unknown[]) => recordUsage(...a),
}));
vi.mock('./build.js', () => ({
  buildReportSnapshot: (...a: unknown[]) => buildReportSnapshot(...a),
}));

const { generateReport, deleteReport } = await import('./generate.js');

function makeDb() {
  const reports: any[] = [];
  const audits: any[] = [];
  let seq = 0;
  return {
    reports,
    audits,
    organization: { findUnique: vi.fn(async () => ({ name: 'Acme Inc' })) },
    report: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        let rows = reports.filter(
          (r) =>
            r.organizationId === where.organizationId &&
            (!where.type || r.type === where.type) &&
            (!where.status || r.status === where.status) &&
            (!where.id || r.id === where.id),
        );
        if (orderBy?.createdAt === 'desc') rows = [...rows].reverse();
        return rows[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `rep_${++seq}`, createdAt: new Date(Date.now() + seq), ...data };
        reports.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = reports.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const i = reports.findIndex((r) => r.id === where.id);
        reports.splice(i, 1);
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => void audits.push(data)) },
  };
}

const input = { organizationId: 'org_1', userId: 'u1', type: 'YOUTUBE' as const };

beforeEach(() => {
  enforceUsage.mockClear();
  recordUsage.mockClear();
  buildReportSnapshot.mockReset();
});

describe('generateReport', () => {
  it('enforces the REPORTS limit, builds a snapshot, and marks the report READY', async () => {
    buildReportSnapshot.mockResolvedValue({
      snapshot: sampleSnapshot(),
      subjectRef: 'ch_1',
      dataThrough: new Date('2026-09-07'),
      connected: true,
    });
    const db = makeDb();
    const res = await generateReport(input, { db: db as never });
    expect(res.status).toBe('READY');
    expect(enforceUsage).toHaveBeenCalledWith(
      expect.objectContaining({ meter: 'REPORTS', amount: 1 }),
      db,
    );
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ meter: 'REPORTS', idempotencyKey: `report:${res.reportId}` }),
      db,
    );
    const row = db.reports.find((r) => r.id === res.reportId);
    expect(row.status).toBe('READY');
    expect(row.snapshot.meta.type).toBe('YOUTUBE');
    expect(db.audits.some((a: any) => a.action === 'report.generated')).toBe(true);
  });

  it('links the new report to the previous READY report of the same type', async () => {
    buildReportSnapshot.mockResolvedValue({
      snapshot: sampleSnapshot(),
      subjectRef: 'ch_1',
      dataThrough: null,
      connected: true,
    });
    const db = makeDb();
    db.reports.push({
      id: 'rep_prev',
      organizationId: 'org_1',
      type: 'YOUTUBE',
      status: 'READY',
      snapshot: sampleSnapshot(),
      createdAt: new Date(1),
    });
    const res = await generateReport(input, { db: db as never });
    const row = db.reports.find((r) => r.id === res.reportId);
    expect(row.previousReportId).toBe('rep_prev');
    const [, buildArgs] = buildReportSnapshot.mock.calls[0]! as [unknown, unknown];
    void buildArgs;
    expect(
      (buildReportSnapshot.mock.calls[0]![0] as { previous?: unknown }).previous,
    ).toMatchObject({
      reportId: 'rep_prev',
    });
  });

  it('marks the report FAILED and records an audit when the build throws', async () => {
    buildReportSnapshot.mockRejectedValue(new Error('gather blew up'));
    const db = makeDb();
    const res = await generateReport(input, { db: db as never });
    expect(res.status).toBe('FAILED');
    expect(res.error).toMatch(/gather blew up/);
    const row = db.reports.find((r) => r.id === res.reportId);
    expect(row.status).toBe('FAILED');
    expect(recordUsage).not.toHaveBeenCalled();
    expect(db.audits.some((a: any) => a.action === 'report.failed')).toBe(true);
  });

  it('propagates a usage-limit error before creating any row', async () => {
    enforceUsage.mockRejectedValueOnce(
      Object.assign(new Error('over'), { code: 'usage_limit_exceeded' }),
    );
    const db = makeDb();
    await expect(generateReport(input, { db: db as never })).rejects.toThrow(/over/);
    expect(db.reports).toHaveLength(0);
  });
});

describe('deleteReport', () => {
  it('deletes an org-owned report and audits it', async () => {
    const db = makeDb();
    db.reports.push({ id: 'rep_x', organizationId: 'org_1', type: 'SEO' });
    await deleteReport({ organizationId: 'org_1', userId: 'u1', reportId: 'rep_x' }, db as never);
    expect(db.reports).toHaveLength(0);
    expect(db.audits.some((a: any) => a.action === 'report.deleted')).toBe(true);
  });

  it('is tenant-scoped', async () => {
    const db = makeDb();
    db.reports.push({ id: 'rep_x', organizationId: 'org_1', type: 'SEO' });
    await expect(
      deleteReport({ organizationId: 'org_2', userId: 'u1', reportId: 'rep_x' }, db as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });
});
