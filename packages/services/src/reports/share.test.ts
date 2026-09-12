import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { getReportForShare } from './read.js';
import { sampleSnapshot } from './sample.js';
import { createShareLink, revokeShareLink, shareLinkActive } from './share.js';

function makeDb(seed: Record<string, unknown> = {}) {
  const report: any = {
    id: 'rep_1',
    organizationId: 'org_1',
    type: 'YOUTUBE',
    title: 'YouTube performance',
    status: 'READY',
    snapshot: sampleSnapshot(),
    shareToken: null,
    shareExpiresAt: null,
    shareRevokedAt: null,
    shareCreatedById: null,
    ...seed,
  };
  const audits: any[] = [];
  return {
    report,
    audits,
    reportTable: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === report.id && where.organizationId === report.organizationId ? report : null,
      ),
      findUnique: vi.fn(async ({ where }: any) =>
        where.shareToken && where.shareToken === report.shareToken ? report : null,
      ),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(report, data);
        return report;
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => void audits.push(data)) },
  };
}

// Adapt to the prisma-ish `db.report` name.
function db(m: ReturnType<typeof makeDb>) {
  return { report: m.reportTable, auditLog: m.auditLog } as never;
}

const base = { organizationId: 'org_1', userId: 'u1', reportId: 'rep_1' };

describe('createShareLink', () => {
  it('creates a url-safe token with an expiry and audits it', async () => {
    const m = makeDb();
    const link = await createShareLink({ ...base, expiresInDays: 30 }, db(m));
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(link.url).toBe(`/r/${link.token}`);
    expect(new Date(link.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(m.report.shareToken).toBe(link.token);
    expect(m.audits.some((a) => a.action === 'report.share.created')).toBe(true);
  });

  it('reuses the existing token when re-shared', async () => {
    const m = makeDb({ shareToken: 'existing-token-value-xxxxxxxxxxxxxxxxxxxx' });
    const link = await createShareLink({ ...base, expiresInDays: null }, db(m));
    expect(link.token).toBe('existing-token-value-xxxxxxxxxxxxxxxxxxxx');
    expect(link.expiresAt).toBeNull();
  });

  it('refuses to share a report that is not READY', async () => {
    const m = makeDb({ status: 'BUILDING' });
    await expect(createShareLink(base, db(m))).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'validation_failed',
    );
  });

  it('is tenant-scoped', async () => {
    const m = makeDb();
    await expect(createShareLink({ ...base, organizationId: 'org_2' }, db(m))).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'resource_not_found',
    );
  });
});

describe('revokeShareLink + shareLinkActive', () => {
  it('revokes an active link', async () => {
    const m = makeDb({ shareToken: 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(shareLinkActive(m.report)).toBe(true);
    await revokeShareLink(base, db(m));
    expect(m.report.shareRevokedAt).toBeInstanceOf(Date);
    expect(shareLinkActive(m.report)).toBe(false);
  });

  it('shareLinkActive is false for expired links', () => {
    expect(
      shareLinkActive({
        shareToken: 't',
        shareExpiresAt: new Date(Date.now() - 1000),
        shareRevokedAt: null,
      }),
    ).toBe(false);
  });
});

describe('getReportForShare', () => {
  it('returns a REDACTED snapshot for an active token', async () => {
    const m = makeDb({ shareToken: 'live-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const out = await getReportForShare('live-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', db(m));
    expect(out).not.toBeNull();
    expect(out!.snapshot.meta.isPublic).toBe(true);
    expect(out!.snapshot.meta.subjectLabel).toBe('a YouTube channel');
    expect(JSON.stringify(out!.snapshot)).not.toContain('Acme Channel');
  });

  it('returns null for an unknown, revoked, expired or non-READY token', async () => {
    expect(await getReportForShare('short', db(makeDb()))).toBeNull();
    const revoked = makeDb({
      shareToken: 'revoked-token-aaaaaaaaaaaaaaaaaaaaaaaaaa',
      shareRevokedAt: new Date(),
    });
    expect(
      await getReportForShare('revoked-token-aaaaaaaaaaaaaaaaaaaaaaaaaa', db(revoked)),
    ).toBeNull();
    const building = makeDb({
      shareToken: 'x-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'BUILDING',
    });
    expect(
      await getReportForShare('x-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', db(building)),
    ).toBeNull();
  });
});
