import { describe, expect, it, vi } from 'vitest';
import { getReport, listReports, reportTypeAvailability } from './read.js';
import { sampleSnapshot } from './sample.js';

function makeDb(rows: any[] = [], counts: Record<string, number> = {}) {
  return {
    report: {
      findMany: vi.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.organizationId === where.organizationId && (!where.type || r.type === where.type),
        ),
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rows.find((r) => r.id === where.id && r.organizationId === where.organizationId) ?? null,
      ),
    },
    youTubeChannel: { count: vi.fn(async () => counts.yt ?? 0) },
    tikTokAccount: { count: vi.fn(async () => counts.tt ?? 0) },
    crawl: { count: vi.fn(async () => counts.crawl ?? 0) },
    recommendation: { count: vi.fn(async () => counts.rec ?? 0) },
    monetizationOpportunity: { count: vi.fn(async () => counts.monet ?? 0) },
  };
}

function reportRow(over: Record<string, unknown> = {}) {
  return {
    id: 'rep_1',
    organizationId: 'org_1',
    type: 'YOUTUBE',
    title: 'YouTube performance',
    status: 'READY',
    createdAt: new Date('2026-09-08'),
    finishedAt: new Date('2026-09-08'),
    dataThrough: new Date('2026-09-07'),
    error: null,
    previousReportId: null,
    snapshot: sampleSnapshot(),
    shareToken: null,
    shareExpiresAt: null,
    shareRevokedAt: null,
    ...over,
  };
}

describe('listReports', () => {
  it('maps rows to list items with the exec headline and share state', async () => {
    const db = makeDb([
      reportRow(),
      reportRow({ id: 'rep_2', status: 'FAILED', snapshot: null, error: 'boom' }),
      reportRow({ id: 'rep_3', shareToken: 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    ]);
    const list = await listReports('org_1', {}, db as never);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ status: 'READY', headline: expect.stringMatching(/Acme/) });
    expect(list[1]).toMatchObject({ status: 'FAILED', headline: null, error: 'boom' });
    expect(list[2]).toMatchObject({ hasShareLink: true, shareActive: true });
  });
});

describe('getReport', () => {
  it('returns the full snapshot + share detail for an org-owned report', async () => {
    const db = makeDb([reportRow({ shareToken: 'tok-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })]);
    const r = await getReport('org_1', 'rep_1', db as never);
    expect(r?.snapshot?.meta.type).toBe('YOUTUBE');
    expect(r?.share).toMatchObject({
      hasLink: true,
      active: true,
      url: '/r/tok-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
  });

  it('returns null for another org', async () => {
    const db = makeDb([reportRow()]);
    expect(await getReport('org_2', 'rep_1', db as never)).toBeNull();
  });
});

describe('reportTypeAvailability', () => {
  it('marks a type available only when its data source has data', async () => {
    const db = makeDb([], { yt: 1, crawl: 2, rec: 5 });
    const avail = await reportTypeAvailability('org_1', db as never);
    const byType = Object.fromEntries(avail.map((a) => [a.type, a.available]));
    expect(byType.YOUTUBE).toBe(true);
    expect(byType.TIKTOK).toBe(false);
    expect(byType.SEO).toBe(true);
    expect(byType.WEBSITE_HEALTH).toBe(true);
    expect(byType.AI_RECOMMENDATIONS).toBe(true);
    expect(byType.GROWTH).toBe(true);
    expect(byType.MONETIZATION).toBe(false);
    expect(avail).toHaveLength(7);
  });
});
