import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import { CATEGORY_WEIGHTS, SEVERITY_PENALTY } from '../seo/scoring.js';
import { createTaskFromRecommendation } from './tasks.js';
import { getConversation, searchConversations } from './conversations.js';
import { runGrowthAgentTurn } from './orchestrator.js';

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

async function seed(tag: string) {
  const db = prisma!;
  const org = await db.organization.create({ data: { name: tag, slug: tag } });
  const site = await db.website.create({
    data: {
      organizationId: org.id,
      url: 'https://example.test',
      hostname: 'example.test',
      verificationToken: 't',
      verified: true,
    },
  });
  const crawl = await db.crawl.create({
    data: {
      websiteId: site.id,
      organizationId: org.id,
      status: 'COMPLETED',
      renderMode: 'STATIC',
      config: {},
      pagesCrawled: 12,
      issuesFound: 2,
      finishedAt: new Date(),
      scores: {
        overall: 62,
        grade: 'C',
        categories: [
          { category: 'metadata', score: 55, issueCount: 1, weightedPenalty: 45, bySeverity: {} },
          {
            category: 'indexability',
            score: 60,
            issueCount: 1,
            weightedPenalty: 40,
            bySeverity: {},
          },
        ],
        weights: CATEGORY_WEIGHTS,
        severityPenalties: SEVERITY_PENALTY,
        pagesAnalyzed: 12,
        note: 'diagnostic',
      } as unknown as object,
      summary: {
        byDepth: { '0': 1, '1': 11 },
        indexablePages: 9,
        nonIndexablePages: 3,
        orphanPages: 2,
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
        robots: { present: true, fullyDisallowed: false, importantPathsBlocked: 0 },
      } as unknown as object,
    },
  });
  for (let i = 0; i < 12; i++) {
    await db.crawlPage.create({
      data: {
        crawlId: crawl.id,
        organizationId: org.id,
        url: `https://example.test/p-${i}`,
        normalizedUrl: `https://example.test/p-${i}`,
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
        internalLinkCount: 5,
        simhash: i.toString(16).padStart(16, '0'),
      },
    });
  }
  await db.crawlIssue.create({
    data: {
      crawlId: crawl.id,
      websiteId: site.id,
      organizationId: org.id,
      code: 'MISSING_TITLE',
      category: 'metadata',
      severity: 'HIGH',
      normalizedUrl: 'https://example.test/p-0',
      title: 'Missing <title>',
      detail: 'no title',
      evidence: {},
      recommendedFix: 'add a title',
      confidence: 0.9,
      affectedUrlCount: 4,
    },
  });
  return { orgId: org.id };
}

describe('Growth Agent orchestrator (integration)', () => {
  maybe()(
    'runs a full turn: plans, runs the SEO agent, persists a conversation + AgentRun, is searchable',
    async () => {
      const { orgId } = await seed(`agent-int-${Date.now()}`);
      const res = await runGrowthAgentTurn(
        { db: prisma! },
        {
          organizationId: orgId,
          userId: 'user-1',
          message: 'What are the biggest SEO problems and which pages should I fix first?',
        },
      );

      expect(res.plan.capabilities).toContain('seo-agent');
      expect(res.blocks.recommendations.length).toBeGreaterThan(0);
      expect(res.responseText.length).toBeGreaterThan(0);

      const convo = await getConversation(
        { organizationId: orgId, userId: 'user-1', conversationId: res.conversationId },
        prisma!,
      );
      expect(convo.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
      expect(
        (convo.messages[1]!.blocks as { recommendations?: unknown[] }).recommendations!.length,
      ).toBeGreaterThan(0);

      const run = await prisma!.agentRun.findFirst({
        where: { organizationId: orgId, agent: 'growth-agent' },
        orderBy: { createdAt: 'desc' },
      });
      expect(run?.status).toBe('COMPLETED');

      const found = await searchConversations(
        { organizationId: orgId, userId: 'user-1', query: 'SEO problems' },
        prisma!,
      );
      expect(found.map((f) => f.id)).toContain(res.conversationId);
    },
  );

  maybe()('a recommendation from the turn can become a task', async () => {
    const { orgId } = await seed(`agent-task-${Date.now()}`);
    await runGrowthAgentTurn(
      { db: prisma! },
      {
        organizationId: orgId,
        userId: 'user-1',
        message: 'Which technical SEO problems should I fix first?',
      },
    );
    const rec = await prisma!.recommendation.findFirst({
      where: { organizationId: orgId, domain: 'SEO' },
      orderBy: { priorityScore: 'desc' },
    });
    expect(rec).toBeTruthy();
    const task = await createTaskFromRecommendation(
      { organizationId: orgId, userId: 'user-1', recommendationId: rec!.id },
      prisma!,
    );
    expect(task.title).toBe(rec!.title);
    expect(task.status).toBe('PENDING');
  });

  maybe()('refuses another org’s conversation', async () => {
    const { orgId } = await seed(`agent-iso-${Date.now()}`);
    const res = await runGrowthAgentTurn(
      { db: prisma! },
      { organizationId: orgId, userId: 'user-1', message: 'analyze my website' },
    );
    const other = await prisma!.organization.create({
      data: { name: `o-${Date.now()}`, slug: `o-${Date.now()}` },
    });
    await expect(
      runGrowthAgentTurn(
        { db: prisma! },
        {
          organizationId: other.id,
          userId: 'user-2',
          conversationId: res.conversationId,
          message: 'hi',
        },
      ),
    ).rejects.toSatisfy((e) => isAppError(e));
  });
});
