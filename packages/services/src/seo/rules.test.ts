import { describe, expect, it } from 'vitest';
import { analyzeGraph, type GraphPage } from './link-graph.js';
import type { PageRecord } from './page-eval.js';
import { type AuditContext, runRules } from './rules.js';
import { parseRobots } from './robots.js';
import { CrawlConfig } from './schemas.js';

function pageRecord(over: Partial<PageRecord>): PageRecord {
  return {
    url: 'https://x.com/',
    normalizedUrl: 'https://x.com/',
    depth: 0,
    discoveredVia: 'seed',
    httpStatus: 200,
    finalUrl: 'https://x.com/',
    redirectChain: [],
    fetchError: null,
    contentType: 'text/html',
    htmlBytes: 1000,
    responseTimeMs: 100,
    renderedWithJs: false,
    title: 'A fine title for the page',
    titleLength: 25,
    metaDescription: 'A perfectly reasonable meta description that is long enough to be fine here.',
    metaDescriptionLength: 74,
    metaRobots: null,
    xRobotsTag: null,
    canonicalUrl: null,
    canonicalIsSelf: null,
    noindex: false,
    robotsBlocked: false,
    indexable: true,
    indexabilityReason: null,
    crawlable: true,
    lang: 'en',
    hreflang: [],
    h1Count: 1,
    headingOutline: [{ level: 1, text: 'H' }],
    wordCount: 400,
    contentHash: null,
    simhash: null,
    ogTags: { 'og:title': 't', 'og:description': 'd', 'og:image': 'i' },
    twitterTags: {},
    jsonLdTypes: ['WebPage'],
    jsonLdErrors: [],
    jsonLdEntities: [],
    landmarkCount: 3,
    hasMainLandmark: true,
    viewportMeta: true,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    imagesMissingDim: 0,
    internalLinkCount: 5,
    externalLinkCount: 1,
    isHttps: true,
    securityHeaders: {},
    mixedContent: false,
    csrLikely: false,
    staticWordCount: 400,
    renderedWordCount: null,
    outboundLinks: [],
    ...over,
  };
}

function ctx(pages: PageRecord[], over: Partial<AuditContext> = {}): AuditContext {
  const graph = analyzeGraph({
    pages: pages.map((p) => toGraphPage(p)),
    seeds: [pages[0]?.normalizedUrl ?? ''],
    sitemapUrls: [],
    maxDepth: 5,
  });
  return {
    pages,
    graph,
    config: CrawlConfig.parse({
      seedUrl: 'https://x.com/',
      hostname: 'x.com',
      registrableDomain: 'x.com',
      maxPages: 100,
      maxDepth: 5,
      maxDurationSec: 600,
      concurrency: 2,
      crawlDelayMs: 250,
    }),
    robots: {
      present: true,
      parsed: parseRobots('User-agent: *\nAllow: /'),
      fullyDisallowed: false,
      importantPathsBlocked: [],
    },
    sitemap: {
      declaredCount: 1,
      urls: [],
      issues: [],
      inSitemapNotCrawled: [],
      crawledNotInSitemap: [],
      nonIndexableInSitemap: [],
    },
    ...over,
  };
}

function toGraphPage(p: PageRecord): GraphPage {
  return {
    normalizedUrl: p.normalizedUrl,
    httpStatus: p.httpStatus,
    redirectChain: p.redirectChain,
    indexable: p.indexable,
    noindex: p.noindex,
    title: p.title,
    metaDescription: p.metaDescription,
    contentHash: p.contentHash,
    simhash: p.simhash,
    canonicalUrl: p.canonicalUrl,
    wordCount: p.wordCount,
    outboundLinks: p.outboundLinks.map((l) => ({
      toNormalizedUrl: l.toNormalizedUrl,
      isInternal: l.isInternal,
      isNofollow: l.isNofollow,
    })),
  };
}

describe('runRules', () => {
  it('a healthy page yields no critical/high issues', () => {
    const issues = runRules(ctx([pageRecord({})]));
    expect(issues.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH')).toHaveLength(
      0,
    );
  });

  it('flags a missing title', () => {
    const issues = runRules(ctx([pageRecord({ title: null, titleLength: null })]));
    expect(issues.map((i) => i.code)).toContain('MISSING_TITLE');
  });

  it('flags a 5xx as a server error', () => {
    const issues = runRules(ctx([pageRecord({ httpStatus: 503 })]));
    const se = issues.find((i) => i.code === 'SERVER_ERROR');
    expect(se?.severity).toBe('HIGH');
  });

  it('flags a broken internal link', () => {
    const home = pageRecord({
      outboundLinks: [
        {
          toNormalizedUrl: 'https://x.com/dead',
          isInternal: true,
          isNofollow: false,
          rel: null,
          anchorText: 'x',
        },
      ],
    });
    const dead = pageRecord({
      normalizedUrl: 'https://x.com/dead',
      url: 'https://x.com/dead',
      httpStatus: 404,
      indexable: false,
    });
    const issues = runRules(ctx([home, dead]));
    expect(issues.map((i) => i.code)).toContain('BROKEN_INTERNAL_LINK');
  });

  it('flags content that requires JS', () => {
    const issues = runRules(
      ctx([pageRecord({ csrLikely: true, staticWordCount: 3, renderedWordCount: 400 })]),
    );
    const csr = issues.find((i) => i.code === 'CONTENT_REQUIRES_JS');
    expect(csr?.severity).toBe('HIGH');
  });

  it('flags a page served over HTTP', () => {
    const issues = runRules(ctx([pageRecord({ finalUrl: 'http://x.com/', isHttps: false })]));
    expect(issues.map((i) => i.code)).toContain('HTTP_NOT_HTTPS');
  });

  it('flags a full robots disallow as critical', () => {
    const issues = runRules(
      ctx([pageRecord({})], {
        robots: {
          present: true,
          parsed: parseRobots('User-agent: *\nDisallow: /'),
          fullyDisallowed: true,
          importantPathsBlocked: [],
        },
      }),
    );
    const blocked = issues.find((i) => i.code === 'ROBOTS_FULL_DISALLOW');
    expect(blocked?.severity).toBe('CRITICAL');
  });

  it('every issue carries the required shape', () => {
    const issues = runRules(
      ctx([pageRecord({ title: null, httpStatus: 500, imagesMissingAlt: 2, imagesTotal: 3 })]),
    );
    for (const i of issues) {
      expect(i.code).toBeTruthy();
      expect(i.category).toBeTruthy();
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).toContain(i.severity);
      expect(i.recommendedFix.length).toBeGreaterThan(0);
      expect(i.confidence).toBeGreaterThan(0);
    }
  });
});
