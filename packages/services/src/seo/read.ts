/**
 * Org-scoped read helpers for the SEO dashboard. Every query is filtered by
 * `organizationId` — a caller can never read another tenant's website or crawl.
 */
import { type Db, prisma } from '@growth-agent/db';
import type { CrawlScore } from './scoring.js';
import type { CrawlSummary } from './schemas.js';

export async function listWebsites(organizationId: string, db: Db = prisma) {
  const sites = await db.website.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: {
      crawls: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          createdAt: true,
          pagesCrawled: true,
          issuesFound: true,
          scores: true,
        },
      },
      _count: { select: { crawls: true, issues: true } },
    },
  });
  return sites.map((s) => ({
    id: s.id,
    url: s.url,
    hostname: s.hostname,
    verified: s.verified,
    verificationMethod: s.verificationMethod,
    verificationToken: s.verificationToken,
    createdAt: s.createdAt,
    crawlCount: s._count.crawls,
    latestCrawl: s.crawls[0]
      ? {
          id: s.crawls[0].id,
          status: s.crawls[0].status,
          createdAt: s.crawls[0].createdAt,
          pagesCrawled: s.crawls[0].pagesCrawled,
          issuesFound: s.crawls[0].issuesFound,
          overallScore: (s.crawls[0].scores as unknown as CrawlScore | null)?.overall ?? null,
        }
      : null,
  }));
}

export async function getWebsite(organizationId: string, websiteId: string, db: Db = prisma) {
  return db.website.findFirst({ where: { id: websiteId, organizationId } });
}

export async function listCrawls(organizationId: string, websiteId: string, db: Db = prisma) {
  return db.crawl.findMany({
    where: { organizationId, websiteId },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true,
      status: true,
      renderMode: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      pagesCrawled: true,
      issuesFound: true,
      blockedReason: true,
      error: true,
      scores: true,
    },
  });
}

export async function getCrawl(organizationId: string, crawlId: string, db: Db = prisma) {
  const crawl = await db.crawl.findFirst({
    where: { id: crawlId, organizationId },
    include: { website: true },
  });
  if (!crawl) return null;
  return {
    ...crawl,
    scores: (crawl.scores as unknown as CrawlScore | null) ?? null,
    summary: (crawl.summary as unknown as CrawlSummary | null) ?? null,
    config: crawl.config as unknown as Record<string, unknown>,
  };
}

export async function getCrawlOverview(organizationId: string, crawlId: string, db: Db = prisma) {
  const crawl = await getCrawl(organizationId, crawlId, db);
  if (!crawl) return null;

  const [issueCountsRaw, statusCounts] = await Promise.all([
    db.crawlIssue.groupBy({
      by: ['category', 'severity'],
      where: { crawlId },
      _count: { _all: true },
    }),
    db.crawlPage.groupBy({
      by: ['httpStatus'],
      where: { crawlId },
      _count: { _all: true },
    }),
  ]);

  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const row of issueCountsRaw) {
    bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + row._count._all;
    byCategory[row.category] = (byCategory[row.category] ?? 0) + row._count._all;
  }

  return {
    crawl,
    issues: {
      total: issueCountsRaw.reduce((s, r) => s + r._count._all, 0),
      bySeverity,
      byCategory,
    },
    statusCounts: statusCounts.map((s) => ({ status: s.httpStatus, count: s._count._all })),
  };
}

export async function listCrawlIssues(
  organizationId: string,
  crawlId: string,
  opts: { category?: string; severity?: string; cursor?: string; limit?: number } = {},
  db: Db = prisma,
) {
  // Enforce tenant scope via the parent crawl.
  const crawl = await db.crawl.findFirst({
    where: { id: crawlId, organizationId },
    select: { id: true },
  });
  if (!crawl) return { issues: [], nextCursor: null, total: 0 };
  const limit = Math.min(100, Math.max(10, opts.limit ?? 50));
  const where = {
    crawlId,
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.severity ? { severity: opts.severity as never } : {}),
  };
  const [rows, total] = await Promise.all([
    db.crawlIssue.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { affectedUrlCount: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    }),
    db.crawlIssue.count({ where }),
  ]);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    issues: page,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    total,
  };
}

export async function listCrawlPages(
  organizationId: string,
  crawlId: string,
  opts: { cursor?: string; limit?: number; onlyProblems?: boolean } = {},
  db: Db = prisma,
) {
  const crawl = await db.crawl.findFirst({
    where: { id: crawlId, organizationId },
    select: { id: true },
  });
  if (!crawl) return { pages: [], nextCursor: null };
  const limit = Math.min(100, Math.max(10, opts.limit ?? 50));
  const rows = await db.crawlPage.findMany({
    where: {
      crawlId,
      ...(opts.onlyProblems
        ? {
            OR: [{ httpStatus: { gte: 400 } }, { indexable: false }, { fetchError: { not: null } }],
          }
        : {}),
    },
    orderBy: [{ depth: 'asc' }, { normalizedUrl: 'asc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      normalizedUrl: true,
      depth: true,
      httpStatus: true,
      indexable: true,
      indexabilityReason: true,
      title: true,
      wordCount: true,
      responseTimeMs: true,
      internalLinkCount: true,
      fetchError: true,
      renderedWithJs: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { pages: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

export async function getArchitecture(organizationId: string, crawlId: string, db: Db = prisma) {
  const overview = await getCrawlOverview(organizationId, crawlId, db);
  if (!overview) return null;
  const summary = overview.crawl.summary;
  return {
    byDepth: summary?.byDepth ?? {},
    orphanPages: summary?.orphanPages ?? 0,
    brokenInternalLinks: summary?.brokenInternalLinks ?? 0,
    redirectChains: summary?.redirectChains ?? 0,
    redirectLoops: summary?.redirectLoops ?? 0,
    duplicateTitleGroups: summary?.duplicateTitleGroups ?? 0,
    duplicateContentClusters: summary?.duplicateContentClusters ?? 0,
    sitemap: summary?.sitemap ?? null,
    robots: summary?.robots ?? null,
  };
}

export async function listSeoRecommendations(organizationId: string, db: Db = prisma) {
  return db.recommendation.findMany({
    where: { organizationId, domain: 'SEO' },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });
}

export async function latestAuditorRun(organizationId: string, db: Db = prisma) {
  return db.agentRun.findFirst({
    where: { organizationId, agent: 'seo-auditor' },
    orderBy: { createdAt: 'desc' },
  });
}

/** The most recent AI SEO Agent run for a website (matches on the report's websiteId). */
export async function latestSeoAgentReport(
  organizationId: string,
  websiteId: string,
  db: Db = prisma,
) {
  const runs = await db.agentRun.findMany({
    where: { organizationId, agent: 'seo-agent', status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  for (const run of runs) {
    const output = run.output as { websiteId?: string } | null;
    if (output?.websiteId === websiteId) {
      return { runId: run.id, createdAt: run.createdAt, report: run.output };
    }
  }
  return null;
}

export async function listRankedSeoRecommendations(
  organizationId: string,
  websiteId: string,
  db: Db = prisma,
) {
  return db.recommendation.findMany({
    where: { organizationId, domain: 'SEO', subjectRef: websiteId, priorityScore: { not: null } },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  });
}
