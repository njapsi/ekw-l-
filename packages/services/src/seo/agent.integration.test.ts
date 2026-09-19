import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import { runSeoAgent } from './agent.js';
import { CATEGORY_WEIGHTS, SEVERITY_PENALTY } from './scoring.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
// Probe at module load (top-level await), BEFORE tests are defined: the
// `maybe()` helper below is evaluated at collection time, so a probe inside
// `beforeAll` came too late and every test here was silently skipped — even
// in CI with a real database (Phase 2 finding).
let reachable = prisma
  ? await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    )
  : false;

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    reachable = false;
  }
});
afterAll(async () => {
  await prisma?.$disconnect();
});
const maybe = () => (reachable ? it : it.skip);

async function seedCrawl(tag: string) {
  const db = prisma!;
  const org = await db.organization.create({ data: { name: tag, slug: tag } });
  const site = await db.website.create({
    data: {
      organizationId: org.id,
      url: 'https://example.test',
      hostname: 'example.test',
      verificationToken: 'tok',
      verified: true,
    },
  });

  const issues = [
    {
      code: 'NOINDEX_ON_LINKED_PAGE',
      category: 'indexability',
      severity: 'HIGH' as const,
      affectedUrlCount: 4,
      normalizedUrl: 'https://example.test/a',
    },
    {
      code: 'MISSING_TITLE',
      category: 'metadata',
      severity: 'HIGH' as const,
      affectedUrlCount: 5,
      normalizedUrl: 'https://example.test/b',
    },
    {
      code: 'CONTENT_REQUIRES_JS',
      category: 'performance',
      severity: 'HIGH' as const,
      affectedUrlCount: 8,
      normalizedUrl: 'https://example.test/app',
    },
  ];
  const drafts = issues.map((i) => ({
    code: i.code,
    category: i.category,
    severity: i.severity,
    normalizedUrl: i.normalizedUrl,
    title: `${i.code} issue`,
    detail: 'detail',
    evidence: {},
    recommendedFix: 'fix it',
    confidence: 0.8,
    affectedUrlCount: i.affectedUrlCount,
  }));
  const scores = {
    overall: 58,
    grade: 'D' as const,
    categories: [
      { category: 'indexability', score: 45, issueCount: 2, weightedPenalty: 55, bySeverity: {} },
      { category: 'metadata', score: 60, issueCount: 1, weightedPenalty: 40, bySeverity: {} },
      { category: 'performance', score: 55, issueCount: 1, weightedPenalty: 45, bySeverity: {} },
    ],
    weights: CATEGORY_WEIGHTS,
    severityPenalties: SEVERITY_PENALTY,
    pagesAnalyzed: 12,
    note: 'diagnostic',
  };

  const crawl = await db.crawl.create({
    data: {
      websiteId: site.id,
      organizationId: org.id,
      status: 'COMPLETED',
      renderMode: 'STATIC',
      config: { maxPages: 100 },
      pagesCrawled: 12,
      issuesFound: issues.length,
      finishedAt: new Date(),
      scores: scores as unknown as object,
      summary: {
        totalPages: 12,
        byStatusClass: { '2xx': 12 },
        byDepth: { '0': 1, '1': 11 },
        indexablePages: 9,
        nonIndexablePages: 3,
        orphanPages: 2,
        brokenInternalLinks: 0,
        redirectChains: 0,
        redirectLoops: 0,
        duplicateTitleGroups: 1,
        duplicateContentClusters: 0,
        sitemap: {
          declared: 1,
          urls: 12,
          inSitemapNotCrawled: 0,
          crawledNotInSitemap: 2,
          nonIndexableInSitemap: 1,
        },
        robots: {
          present: true,
          fullyDisallowed: false,
          syntaxIssues: 0,
          importantPathsBlocked: 0,
        },
        renderedPages: 0,
        averageResponseMs: 120,
        crawlDurationSec: 5,
        reachedPageCap: false,
        reachedTimeCap: false,
        blocked: false,
      } as unknown as object,
    },
  });

  for (let i = 0; i < 12; i++) {
    await db.crawlPage.create({
      data: {
        crawlId: crawl.id,
        organizationId: org.id,
        url: `https://example.test/page-${i}`,
        normalizedUrl: `https://example.test/page-${i}`,
        depth: i === 0 ? 0 : 1,
        httpStatus: 200,
        indexable: i % 4 !== 0,
        noindex: i % 4 === 0,
        title: i % 3 === 0 ? null : `Page ${i} title long enough`,
        h1Count: 1,
        wordCount: 300,
        jsonLdTypes: i % 2 === 0 ? ['Article'] : [],
        landmarkCount: i % 2 === 0 ? 3 : 0,
        hasMainLandmark: i % 2 === 0,
        canonicalIsSelf: true,
        inboundInternalCount: i % 4 === 0 ? 0 : 3,
        internalLinkCount: 6,
        simhash: i.toString(16).padStart(16, '0'),
      },
    });
  }
  for (const d of drafts) {
    await db.crawlIssue.create({
      data: {
        crawlId: crawl.id,
        websiteId: site.id,
        organizationId: org.id,
        code: d.code,
        category: d.category,
        severity: d.severity,
        normalizedUrl: d.normalizedUrl,
        title: d.title,
        detail: d.detail,
        evidence: {},
        recommendedFix: d.recommendedFix,
        confidence: d.confidence,
        affectedUrlCount: d.affectedUrlCount,
      },
    });
  }
  return { orgId: org.id, siteId: site.id, crawlId: crawl.id };
}

describe('AI SEO Agent (integration)', () => {
  maybe()(
    'ranks recommendations, builds action plans + readability, and persists rows',
    async () => {
      const { orgId, crawlId, siteId } = await seedCrawl(`seo-agent-${Date.now()}`);
      const res = await runSeoAgent({ db: prisma! }, { organizationId: orgId, crawlId });

      expect(res.report.recommendations.length).toBeGreaterThanOrEqual(3);
      expect(res.report.aiReadability.signals).toHaveLength(9);
      const persisted = await prisma!.recommendation.findMany({
        where: { organizationId: orgId, domain: 'SEO', subjectRef: siteId },
      });
      expect(persisted.length).toBe(res.report.recommendations.length);
      expect(persisted.every((r) => r.priorityScore != null && r.actionPlan != null)).toBe(true);

      const run = await prisma!.agentRun.findFirst({
        where: { organizationId: orgId, agent: 'seo-agent' },
        orderBy: { createdAt: 'desc' },
      });
      expect(run?.status).toBe('COMPLETED');
      const output = run?.output as { toolCalls?: unknown[]; websiteId?: string };
      expect(output?.websiteId).toBe(siteId);
      expect((output?.toolCalls ?? []).length).toBeGreaterThanOrEqual(7);
    },
  );

  maybe()('answers a question from stored data', async () => {
    const { orgId, crawlId } = await seedCrawl(`seo-agent-q-${Date.now()}`);
    const res = await runSeoAgent(
      { db: prisma! },
      {
        organizationId: orgId,
        crawlId,
        question: 'Which technical SEO problems should I fix first?',
      },
    );
    expect(res.answer).toMatch(/priority|NOINDEX|MISSING_TITLE|CONTENT_REQUIRES_JS/i);
  });

  maybe()('refuses a cross-tenant crawl', async () => {
    const { crawlId } = await seedCrawl(`seo-agent-iso-${Date.now()}`);
    const other = await prisma!.organization.create({
      data: { name: `other-${Date.now()}`, slug: `other-${Date.now()}` },
    });
    await expect(
      runSeoAgent({ db: prisma! }, { organizationId: other.id, crawlId }),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });
});
