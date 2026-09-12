import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { runSeoAgent } from './agent.js';
import type { SeoAgentModelOutput } from './agent-schema.js';

const CRAWL = {
  id: 'crawl_1',
  organizationId: 'org_1',
  websiteId: 'site_1',
  status: 'COMPLETED' as string,
  renderMode: 'STATIC',
  blockedReason: null,
  startedAt: new Date(),
  finishedAt: new Date(),
  pagesCrawled: 20,
  issuesFound: 4,
  config: { maxPages: 200 },
  scores: {
    overall: 64,
    grade: 'C',
    categories: [
      { category: 'metadata', score: 55 },
      { category: 'indexability', score: 60 },
      { category: 'crawlability', score: 80 },
    ],
  },
  summary: {
    byDepth: { '0': 1, '1': 12, '2': 7 },
    indexablePages: 16,
    nonIndexablePages: 4,
    orphanPages: 3,
    redirectChains: 1,
    redirectLoops: 0,
    duplicateTitleGroups: 2,
    duplicateContentClusters: 0,
    sitemap: {
      declared: 1,
      urls: 20,
      inSitemapNotCrawled: 0,
      crawledNotInSitemap: 3,
      nonIndexableInSitemap: 2,
    },
    robots: { present: true, fullyDisallowed: false, syntaxIssues: 0, importantPathsBlocked: 1 },
  },
  website: { id: 'site_1', organizationId: 'org_1', hostname: 'x.com', url: 'https://x.com' },
};

const ISSUES = [
  {
    id: 'i1',
    code: 'NOINDEX_ON_LINKED_PAGE',
    category: 'indexability',
    severity: 'HIGH',
    normalizedUrl: 'https://x.com/a',
    title: 'Well-linked page is noindex',
    detail: 'd',
    evidence: { inbound: 5 },
    recommendedFix: 'remove noindex',
    confidence: 0.8,
    affectedUrlCount: 3,
    status: 'OPEN',
  },
  {
    id: 'i2',
    code: 'MISSING_TITLE',
    category: 'metadata',
    severity: 'HIGH',
    normalizedUrl: 'https://x.com/b',
    title: 'Missing <title>',
    detail: 'd',
    evidence: {},
    recommendedFix: 'add a title',
    confidence: 0.9,
    affectedUrlCount: 6,
    status: 'OPEN',
  },
  {
    id: 'i3',
    code: 'CONTENT_REQUIRES_JS',
    category: 'performance',
    severity: 'HIGH',
    normalizedUrl: 'https://x.com/app',
    title: 'Content requires JS',
    detail: 'd',
    evidence: {},
    recommendedFix: 'server-render',
    confidence: 0.6,
    affectedUrlCount: 10,
    status: 'OPEN',
  },
  {
    id: 'i4',
    code: 'SITEMAP_NONINDEXABLE_URL',
    category: 'indexability',
    severity: 'MEDIUM',
    normalizedUrl: null,
    title: 'Sitemap lists non-indexable URLs',
    detail: 'd',
    evidence: {},
    recommendedFix: 'clean sitemap',
    confidence: 0.8,
    affectedUrlCount: 2,
    status: 'OPEN',
  },
];

function mkPages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    normalizedUrl: `https://x.com/page-${i}`,
    depth: i === 0 ? 0 : 1,
    httpStatus: 200,
    indexable: i % 5 !== 0,
    indexabilityReason: null,
    noindex: i % 5 === 0,
    robotsBlocked: false,
    canonicalUrl: null,
    canonicalIsSelf: true,
    title: i % 3 === 0 ? null : `Page ${i} title that is descriptive enough`,
    metaDescription: i % 2 === 0 ? 'A description of the page for the snippet.' : null,
    h1Count: i % 4 === 0 ? 0 : 1,
    wordCount: 300 + i * 5,
    jsonLdTypes: i % 2 === 0 ? ['Article'] : [],
    jsonLdErrors: [],
    jsonLdEntities:
      i === 1 ? [{ type: 'Organization', name: 'Acme', url: null, id: null, sameAs: [] }] : [],
    landmarkCount: i % 2 === 0 ? 4 : 0,
    hasMainLandmark: i % 2 === 0,
    internalLinkCount: 5 + (i % 3),
    inboundInternalCount: i % 4 === 0 ? 0 : 3,
    responseTimeMs: 120,
    renderedWithJs: false,
    csrLikely: i === 3,
    fetchError: null,
    simhash: `${i.toString(16).padStart(16, '0')}`,
  }));
}
const PAGES = mkPages(20);

function fakeDb(overrides: { status?: string; org?: string } = {}) {
  const created = { agentRun: [] as any[], recommendation: [] as any[], auditLog: [] as any[] };
  const runUpdates: any[] = [];
  const crawl = { ...CRAWL, status: overrides.status ?? CRAWL.status };
  const org = overrides.org ?? 'org_1';
  return {
    created,
    runUpdates,
    crawl: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.id && where.id !== crawl.id) return null;
        if (where.organizationId && where.organizationId !== org) return null;
        if (where.websiteId && where.websiteId !== crawl.websiteId) return null;
        if (where.status && crawl.status !== where.status) return null;
        return crawl;
      }),
    },
    crawlIssue: {
      findMany: vi.fn(async ({ where }: any) => {
        let rows = [...ISSUES];
        if (where?.code?.startsWith)
          rows = rows.filter((i) => i.code.startsWith(where.code.startsWith));
        if (where?.severity) rows = rows.filter((i) => i.severity === where.severity);
        if (where?.category) rows = rows.filter((i) => i.category === where.category);
        return rows;
      }),
    },
    crawlPage: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          PAGES.find((p) => p.normalizedUrl === where.normalizedUrl || p.id === where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) => {
        let rows = [...PAGES];
        if (where?.indexable !== undefined)
          rows = rows.filter((p) => p.indexable === where.indexable);
        if (where?.inboundInternalCount?.lte !== undefined)
          rows = rows.filter((p) => p.inboundInternalCount <= where.inboundInternalCount.lte);
        if (where?.simhash?.not !== undefined) rows = rows.filter((p) => p.simhash != null);
        return rows;
      }),
      update: vi.fn(async () => ({})),
    },
    crawlLink: { findMany: vi.fn(async () => []) },
    website: {
      findUnique: vi.fn(async () => ({
        robotsTxtCache: 'User-agent: *\nAllow: /\nSitemap: https://x.com/sitemap.xml',
        robotsFetchedAt: new Date(),
      })),
    },
    agentRun: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `run_${created.agentRun.length}`, ...data };
        created.agentRun.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: any) => {
        runUpdates.push(data);
        return {};
      }),
    },
    recommendation: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `rec_${created.recommendation.length}`, ...data };
        created.recommendation.push(row);
        return row;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

const USAGE = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-5',
  promptTokens: 900,
  completionTokens: 400,
  totalTokens: 1300,
  estimatedCostUsd: 0.015,
};

function groundedOutput(): SeoAgentModelOutput {
  return {
    answer:
      'Pages are missing from Google mainly because of NOINDEX_ON_LINKED_PAGE and MISSING_TITLE.',
    answerEvidenceFactIds: ['rec_NOINDEX_ON_LINKED_PAGE_affected', 'rec_MISSING_TITLE_affected'],
    executiveSummary:
      'The crawl of x.com scores in the middle band with high-severity indexability and metadata issues to address first.',
    executiveSummaryEvidenceFactIds: ['score_overall', 'issues_high'],
    recommendationNotes: [
      {
        code: 'NOINDEX_ON_LINKED_PAGE',
        whyItMatters:
          'Prominently linked pages set to noindex will not appear in search or AI answers.',
        evidenceFactIds: ['rec_NOINDEX_ON_LINKED_PAGE_affected'],
      },
    ],
    aiReadabilityNote: 'Machine readability is limited mainly by structured-data coverage.',
    aiReadabilityEvidenceFactIds: ['airead_overall'],
    searchConsoleNote: '',
    searchConsoleEvidenceFactIds: [],
    disclaimers: ['This is diagnostic and is not a prediction of search rankings.'],
  };
}

function hallucinatedOutput(): SeoAgentModelOutput {
  const o = groundedOutput();
  o.executiveSummary = 'Fixing these issues will increase organic traffic by 300% within 30 days.';
  o.executiveSummaryEvidenceFactIds = ['made_up_fact'];
  return o;
}

describe('runSeoAgent', () => {
  it('produces the full deterministic report without a model (tools gathered, no crawl performed)', async () => {
    const db = fakeDb();
    const res = await runSeoAgent(
      { db: db as never },
      { organizationId: 'org_1', crawlId: 'crawl_1' },
    );

    expect(res.usedModel).toBe(false);
    expect(res.report.narrativeSource).toBe('deterministic');
    // It gathered evidence via the restricted tools.
    const toolNames = res.report.toolCalls.map((c) => c.tool);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'seo.get_crawl',
        'seo.get_issues',
        'seo.get_site_architecture',
        'seo.get_sitemap',
        'seo.get_robots',
        'seo.get_schema',
        'seo.get_internal_links',
        'seo.get_page',
      ]),
    );
    expect(res.report.toolCatalogue).toHaveLength(15); // 9 seo.* + 6 gsc.* tools
    // Ranked recommendations + four action plans.
    expect(res.report.recommendations.length).toBeGreaterThan(0);
    const plans = res.report.actionPlans;
    const total =
      plans.quickWins.length +
      plans.highImpact.length +
      plans.technicalProjects.length +
      plans.longTerm.length;
    expect(total).toBe(res.report.recommendations.length);
    // AI-readability analysis present with established/experimental signals.
    expect(res.report.aiReadability.signals).toHaveLength(9);
    // Persisted with priority score + action plan.
    expect(db.created.recommendation.length).toBe(res.report.recommendations.length);
    expect(db.created.recommendation[0]).toMatchObject({ domain: 'SEO' });
    expect(typeof db.created.recommendation[0].priorityScore).toBe('number');
    expect(db.created.recommendation[0].actionPlan).toBeTruthy();
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"COMPLETED"');
  });

  it('runs with no Search Console property: report.searchConsole.connected === false, crawler-only', async () => {
    const db = fakeDb();
    const res = await runSeoAgent(
      { db: db as never },
      { organizationId: 'org_1', crawlId: 'crawl_1' },
    );
    expect(res.report.searchConsole.connected).toBe(false);
    expect(res.report.searchConsole.correlations).toEqual([]);
    expect(res.report.toolCalls.map((c) => c.tool)).not.toContain('gsc.get_performance');
  });

  it('combines crawler + Search Console when a verified selected property matches the hostname', async () => {
    const db = fakeDb();
    const gscDb = {
      ...db,
      searchConsoleSite: {
        findFirst: vi.fn(async () => ({
          id: 'gsc_1',
          organizationId: 'org_1',
          siteUrl: 'sc-domain:x.com',
          hostname: 'x.com',
          propertyType: 'DOMAIN',
          permissionLevel: 'SITE_OWNER',
          isSelected: true,
          verified: true,
        })),
      },
      searchConsoleSnapshot: {
        findFirst: vi.fn(async () => ({
          id: 'snap_1',
          capturedAt: new Date('2026-09-10'),
          rangeEnd: new Date('2026-09-08'),
          data: {
            rangeDays: 28,
            totals: { clicks: 40, impressions: 4000, ctr: 0.01, position: 12 },
            byDate: [],
            byQuery: [
              { keys: ['widgets'], clicks: 30, impressions: 3000, ctr: 0.01, position: 11 },
            ],
            byPage: [
              // page-0 is noindex in mkPages (i%5===0) and has an issue via /a? no —
              // use the crawl's /a which carries NOINDEX_ON_LINKED_PAGE + is in the crawl pages.
              { keys: ['https://x.com/a'], clicks: 5, impressions: 800, ctr: 0.006, position: 15 },
            ],
            byCountry: [],
            byDevice: [],
            bySearchAppearance: [],
          },
        })),
      },
    };
    const res = await runSeoAgent(
      { db: gscDb as never },
      { organizationId: 'org_1', crawlId: 'crawl_1' },
    );
    const sc = res.report.searchConsole;
    expect(sc.connected).toBe(true);
    expect(sc.totals?.impressions).toBe(4000);
    expect(sc.dataThrough).toBe('2026-09-08');
    expect(sc.topQueries?.[0]?.query).toBe('widgets');
    expect(res.report.toolCalls.map((c) => c.tool)).toContain('gsc.get_performance');
    // A HIGH crawl issue on a page GSC shows impressions for → a labelled correlation.
    const corr = sc.correlations.find((c) => c.kind === 'crawl_issue_on_impression_page');
    expect(corr).toBeTruthy();
    expect(corr!.crawlerEvidence).toMatch(/NOINDEX_ON_LINKED_PAGE/);
    expect(corr!.searchConsoleEvidence).toMatch(/impression/);
    // Disclaimer names the two evidence sources.
    expect(sc.disclaimers.join(' ')).toMatch(/Search Console evidence and crawler evidence/i);
  });

  it('answers a free-form question deterministically when there is no model', async () => {
    const db = fakeDb();
    const res = await runSeoAgent(
      { db: db as never },
      {
        organizationId: 'org_1',
        crawlId: 'crawl_1',
        question: "Why isn't Google finding these pages?",
      },
    );
    expect(res.answer).toMatch(/NOINDEX_ON_LINKED_PAGE|Orphan pages|Indexability/i);
    expect(res.report.question?.text).toBe("Why isn't Google finding these pages?");
  });

  it('merges a grounded model narrative and answer', async () => {
    const db = fakeDb();
    const model = {
      generateObject: vi.fn(async () => ({ object: groundedOutput(), usage: USAGE })),
    };
    const res = await runSeoAgent(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        crawlId: 'crawl_1',
        question: "Why isn't Google finding these pages?",
      },
    );
    expect(res.usedModel).toBe(true);
    expect(res.grounded).toBe(true);
    expect(res.report.narrativeSource).toBe('model');
    expect(res.report.executiveSummary).toMatch(/middle band/i);
    expect(res.answer).toMatch(/NOINDEX_ON_LINKED_PAGE/);
    const noindexRec = res.report.recommendations.find((r) => r.code === 'NOINDEX_ON_LINKED_PAGE');
    expect(noindexRec?.whyItMatters).toMatch(/will not appear in search or AI answers/i);
  });

  it('drops an ungrounded model narrative and falls back to deterministic wording (report still returned)', async () => {
    const db = fakeDb();
    const model = {
      generateObject: vi.fn(async () => ({ object: hallucinatedOutput(), usage: USAGE })),
    };
    const res = await runSeoAgent(
      { db: db as never, model },
      { organizationId: 'org_1', crawlId: 'crawl_1' },
    );
    expect(model.generateObject).toHaveBeenCalledTimes(2); // initial + repair
    expect(res.usedModel).toBe(true);
    expect(res.grounded).toBe(false);
    expect(res.report.narrativeSource).toBe('deterministic');
    expect(res.report.executiveSummary).not.toMatch(/300%|increase organic traffic/i);
    // The deterministic numbers/recommendations are unaffected.
    expect(res.report.recommendations.length).toBeGreaterThan(0);
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"COMPLETED"');
  });

  it('returns a minimal report for a thin crawl without ranking anything', async () => {
    const db = fakeDb({ status: 'RUNNING' });
    const res = await runSeoAgent(
      { db: db as never },
      { organizationId: 'org_1', crawlId: 'crawl_1' },
    );
    expect(res.report.recommendations).toHaveLength(0);
    expect(res.report.dataCoverage).toMatch(/running|nothing to analyse/i);
    expect(db.created.recommendation).toHaveLength(0);
  });

  it('enforces tenant isolation — another org cannot run the agent over the crawl', async () => {
    const db = fakeDb({ org: 'org_1' });
    await expect(
      runSeoAgent({ db: db as never }, { organizationId: 'org_2', crawlId: 'crawl_1' }),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });

  it('never emits a ranking guarantee', async () => {
    const db = fakeDb();
    const res = await runSeoAgent(
      { db: db as never },
      { organizationId: 'org_1', crawlId: 'crawl_1' },
    );
    const text = JSON.stringify(res.report).toLowerCase();
    expect(text).not.toMatch(/guarantee (higher|better|top) rank|will rank #?1|guaranteed traffic/);
    expect(res.report.disclaimers.join(' ')).toMatch(
      /not a prediction or guarantee of search rankings/i,
    );
  });
});
