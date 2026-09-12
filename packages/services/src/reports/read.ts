/**
 * Org-scoped report reads + the public (token) read, which returns a REDACTED
 * snapshot only.
 */
import type { ReportSnapshot } from '@growth-agent/core';
import { type Db, prisma } from '@growth-agent/db';
import { redactSnapshotForPublic } from './redact.js';
import { REPORT_TYPES, type ReportTypeKey } from './schemas.js';
import { shareLinkActive } from './share.js';

export interface ReportListItem {
  id: string;
  type: ReportTypeKey;
  title: string;
  status: 'PENDING' | 'BUILDING' | 'READY' | 'FAILED';
  createdAt: string;
  finishedAt: string | null;
  dataThrough: string | null;
  error: string | null;
  hasShareLink: boolean;
  shareActive: boolean;
  headline: string | null;
}

function toListItem(r: {
  id: string;
  type: string;
  title: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  dataThrough: Date | null;
  error: string | null;
  shareToken: string | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
  snapshot: unknown;
}): ReportListItem {
  const snap = r.snapshot as ReportSnapshot | null;
  return {
    id: r.id,
    type: r.type as ReportTypeKey,
    title: r.title,
    status: r.status as ReportListItem['status'],
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    dataThrough: r.dataThrough?.toISOString() ?? null,
    error: r.error,
    hasShareLink: Boolean(r.shareToken),
    shareActive: shareLinkActive(r),
    headline: snap?.executiveSummary.headline ?? null,
  };
}

export async function listReports(
  organizationId: string,
  opts: { type?: ReportTypeKey; limit?: number } = {},
  db: Db = prisma,
): Promise<ReportListItem[]> {
  const rows = await db.report.findMany({
    where: { organizationId, ...(opts.type ? { type: opts.type } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Math.max(1, opts.limit ?? 60)),
  });
  return rows.map(toListItem);
}

export interface ReportDetail {
  id: string;
  type: ReportTypeKey;
  title: string;
  status: ReportListItem['status'];
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  previousReportId: string | null;
  snapshot: ReportSnapshot | null;
  share: {
    hasLink: boolean;
    active: boolean;
    token: string | null;
    url: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
  };
}

export async function getReport(
  organizationId: string,
  reportId: string,
  db: Db = prisma,
): Promise<ReportDetail | null> {
  const r = await db.report.findFirst({ where: { id: reportId, organizationId } });
  if (!r) return null;
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    error: r.error,
    previousReportId: r.previousReportId,
    snapshot: (r.snapshot as unknown as ReportSnapshot | null) ?? null,
    share: {
      hasLink: Boolean(r.shareToken),
      active: shareLinkActive(r),
      token: r.shareToken,
      url: r.shareToken ? `/r/${r.shareToken}` : null,
      expiresAt: r.shareExpiresAt?.toISOString() ?? null,
      revokedAt: r.shareRevokedAt?.toISOString() ?? null,
    },
  };
}

export interface PublicReport {
  title: string;
  type: ReportTypeKey;
  generatedAt: string;
  snapshot: ReportSnapshot;
}

/**
 * Resolve a share token → a REDACTED snapshot, or `null` when the token is
 * unknown / expired / revoked / not READY. No org-identifying data is returned.
 */
export async function getReportForShare(
  token: string,
  db: Db = prisma,
): Promise<PublicReport | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const r = await db.report.findUnique({ where: { shareToken: token } });
  if (!r || r.status !== 'READY' || !r.snapshot) return null;
  if (!shareLinkActive(r)) return null;

  const redacted = redactSnapshotForPublic(r.snapshot as unknown as ReportSnapshot);
  return {
    title: redacted.meta.title,
    type: r.type,
    generatedAt: redacted.meta.generatedAt,
    snapshot: redacted,
  };
}

export interface TypeAvailability {
  type: ReportTypeKey;
  available: boolean;
  reason: string;
}

/** Which report types have enough data to be worth generating right now. */
export async function reportTypeAvailability(
  organizationId: string,
  db: Db = prisma,
): Promise<TypeAvailability[]> {
  const [ytChannel, ttAccount, siteWithCrawl, recCount, monetOpps] = await Promise.all([
    db.youTubeChannel.count({ where: { organizationId } }),
    db.tikTokAccount.count({ where: { organizationId } }),
    db.crawl.count({ where: { organizationId, status: 'COMPLETED' } }),
    db.recommendation.count({ where: { organizationId } }),
    db.monetizationOpportunity.count({ where: { organizationId } }),
  ]);

  const check = (ok: boolean, reason: string): { available: boolean; reason: string } => ({
    available: ok,
    reason: ok ? 'Ready to generate.' : reason,
  });

  const map: Record<ReportTypeKey, { available: boolean; reason: string }> = {
    YOUTUBE: check(ytChannel > 0, 'Connect a YouTube channel first.'),
    TIKTOK: check(ttAccount > 0, 'Connect a TikTok account first.'),
    SEO: check(siteWithCrawl > 0, 'Run a website crawl first.'),
    WEBSITE_HEALTH: check(siteWithCrawl > 0, 'Run a website crawl first.'),
    AI_RECOMMENDATIONS: check(recCount > 0, 'Run an analysis to generate recommendations first.'),
    GROWTH: check(
      ytChannel + ttAccount + siteWithCrawl + monetOpps > 0,
      'Connect a platform or run an analysis first.',
    ),
    MONETIZATION: check(monetOpps > 0, 'Run a monetization scan first.'),
  };
  return REPORT_TYPES.map((t) => ({ type: t, ...map[t] }));
}
