import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import {
  SEO_AGENT_TOOL_NAMES,
  bindSeoAgentTools,
  describeSeoAgentTools,
  executeSeoTool,
  isSeoAgentToolName,
} from './agent-tools.js';

const CRAWL = {
  id: 'crawl_1',
  organizationId: 'org_1',
  websiteId: 'site_1',
  status: 'COMPLETED',
  renderMode: 'STATIC',
  blockedReason: null,
  startedAt: new Date(),
  finishedAt: new Date(),
  pagesCrawled: 12,
  issuesFound: 3,
  config: { maxPages: 200 },
  scores: { overall: 72, grade: 'B', categories: [{ category: 'metadata', score: 70 }] },
  summary: {
    byDepth: { '0': 1, '1': 8, '2': 3 },
    indexablePages: 10,
    nonIndexablePages: 2,
    orphanPages: 1,
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
    robots: { present: true, fullyDisallowed: false, syntaxIssues: 0, importantPathsBlocked: 0 },
  },
  website: { id: 'site_1', organizationId: 'org_1', hostname: 'x.com', url: 'https://x.com' },
};

const ISSUES = [
  {
    id: 'i1',
    code: 'MISSING_TITLE',
    category: 'metadata',
    severity: 'HIGH',
    normalizedUrl: 'https://x.com/a',
    title: 'Missing title',
    detail: 'd',
    evidence: {},
    recommendedFix: 'add',
    confidence: 0.9,
    affectedUrlCount: 2,
    status: 'OPEN',
  },
  {
    id: 'i2',
    code: 'SITEMAP_COVERAGE_GAP',
    category: 'architecture',
    severity: 'INFO',
    normalizedUrl: null,
    title: 'gap',
    detail: 'd',
    evidence: {},
    recommendedFix: 'fix',
    confidence: 0.6,
    affectedUrlCount: 2,
    status: 'OPEN',
  },
];

const PAGES = [
  {
    id: 'p1',
    normalizedUrl: 'https://x.com/',
    depth: 0,
    httpStatus: 200,
    indexable: true,
    indexabilityReason: null,
    noindex: false,
    robotsBlocked: false,
    canonicalUrl: null,
    canonicalIsSelf: true,
    title: 'Home',
    metaDescription: 'desc',
    h1Count: 1,
    wordCount: 300,
    jsonLdTypes: ['WebSite'],
    jsonLdErrors: [],
    jsonLdEntities: [{ type: 'WebSite', name: 'X', url: null, id: null, sameAs: [] }],
    landmarkCount: 3,
    hasMainLandmark: true,
    internalLinkCount: 10,
    inboundInternalCount: 5,
    responseTimeMs: 100,
    renderedWithJs: false,
    csrLikely: false,
    fetchError: null,
    simhash: 'abc123abc123abc1',
  },
  {
    id: 'p2',
    normalizedUrl: 'https://x.com/a',
    depth: 1,
    httpStatus: 200,
    indexable: true,
    indexabilityReason: null,
    noindex: false,
    robotsBlocked: false,
    canonicalUrl: null,
    canonicalIsSelf: true,
    title: null,
    metaDescription: null,
    h1Count: 0,
    wordCount: 200,
    jsonLdTypes: [],
    jsonLdErrors: [],
    jsonLdEntities: [],
    landmarkCount: 0,
    hasMainLandmark: false,
    internalLinkCount: 2,
    inboundInternalCount: 1,
    responseTimeMs: 90,
    renderedWithJs: false,
    csrLikely: false,
    fetchError: null,
    simhash: 'def456def456def4',
  },
];

function fakeDb(org = 'org_1') {
  return {
    crawl: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.id && where.id !== CRAWL.id) return null;
        if (where.organizationId && where.organizationId !== org) return null;
        if (where.websiteId && where.websiteId !== CRAWL.websiteId) return null;
        return CRAWL;
      }),
    },
    crawlIssue: {
      findMany: vi.fn(async ({ where }: any) => {
        let rows = ISSUES.filter(() => true);
        if (where?.code?.startsWith)
          rows = rows.filter((i) => i.code.startsWith(where.code.startsWith));
        if (where?.code && typeof where.code === 'string')
          rows = rows.filter((i) => i.code === where.code);
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
    },
    crawlLink: { findMany: vi.fn(async () => []) },
    website: {
      findUnique: vi.fn(async () => ({
        robotsTxtCache: 'User-agent: *\nAllow: /\nSitemap: https://x.com/sitemap.xml',
        robotsFetchedAt: new Date(),
      })),
      findFirst: vi.fn(async ({ where }: any) =>
        where.organizationId === org && where.id === 'site_1'
          ? {
              ...CRAWL.website,
              verified: true,
              verificationMethod: 'DNS_TXT',
              robotsFetchedAt: new Date(),
              crawls: [],
            }
          : null,
      ),
    },
  };
}

describe('SEO agent tool registry', () => {
  it('exposes exactly the nine restricted, read-only tools from the spec', () => {
    expect([...SEO_AGENT_TOOL_NAMES]).toEqual([
      'seo.get_project',
      'seo.get_crawl',
      'seo.get_page',
      'seo.get_issues',
      'seo.get_internal_links',
      'seo.get_sitemap',
      'seo.get_robots',
      'seo.get_schema',
      'seo.get_site_architecture',
    ]);
    const described = describeSeoAgentTools();
    expect(described).toHaveLength(9);
    expect(described.every((t) => t.readOnly === true)).toBe(true);
  });

  it('rejects any name not in the allowlist', async () => {
    const ctx = { organizationId: 'org_1', db: fakeDb() as never };
    expect(isSeoAgentToolName('seo.delete_page')).toBe(false);
    await expect(executeSeoTool('seo.delete_page', { crawlId: 'crawl_1' }, ctx)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'validation_failed',
    );
    await expect(executeSeoTool('not.a.tool', {}, ctx)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'validation_failed',
    );
  });

  it('validates tool input (crawlId or websiteId is required)', async () => {
    const ctx = { organizationId: 'org_1', db: fakeDb() as never };
    await expect(executeSeoTool('seo.get_crawl', {}, ctx)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'validation_failed',
    );
  });

  it('is scoped to the tenant: another org cannot read the crawl', async () => {
    const ctx = { organizationId: 'org_2', db: fakeDb('org_1') as never };
    await expect(executeSeoTool('seo.get_crawl', { crawlId: 'crawl_1' }, ctx)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'resource_not_found',
    );
  });

  it('get_crawl / get_issues / get_site_architecture return stored data', async () => {
    const tools = bindSeoAgentTools({ organizationId: 'org_1', db: fakeDb() as never });
    const crawl = (await tools.get_crawl({ crawlId: 'crawl_1' })) as {
      scores: { overall: number };
    };
    expect(crawl.scores.overall).toBe(72);
    const issues = (await tools.get_issues({ crawlId: 'crawl_1' })) as { issues: unknown[] };
    expect(issues.issues).toHaveLength(2);
    const arch = (await tools.get_site_architecture({ crawlId: 'crawl_1' })) as {
      orphanPages: number;
    };
    expect(arch.orphanPages).toBe(1);
    const sitemap = (await tools.get_sitemap({ crawlId: 'crawl_1' })) as {
      relatedIssues: unknown[];
    };
    expect(sitemap.relatedIssues).toHaveLength(1); // only SITEMAP_* codes
    const robots = (await tools.get_robots({ crawlId: 'crawl_1' })) as {
      declaredSitemaps: string[];
    };
    expect(robots.declaredSitemaps).toContain('https://x.com/sitemap.xml');
    const schema = (await tools.get_schema({ crawlId: 'crawl_1' })) as {
      indexablePagesWithoutStructuredData: number;
    };
    expect(schema.indexablePagesWithoutStructuredData).toBe(1);
  });

  it('there is no write tool in the registry', () => {
    for (const name of SEO_AGENT_TOOL_NAMES) {
      expect(name.startsWith('seo.get_')).toBe(true);
    }
  });
});
