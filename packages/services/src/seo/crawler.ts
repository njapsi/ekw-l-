/**
 * The crawl runner (docs/SEO-ENGINE.md §1). Consumes a `CrawlPlan`, drives the
 * frontier → fetch → (render) → extract → evaluate → persist → discover loop
 * under all the CRAWL CONTROLS (max pages / depth / time, concurrency, per-host
 * rate limit, retries + backoff, pause / resume / cancel), then finalizes:
 * builds the link graph, runs the auditor rules, persists issues, and computes
 * the category + overall scores.
 *
 * Network I/O is injectable (`lookup` / `transport` / `renderer`) so the whole
 * pipeline is testable without sockets or a browser.
 */
import type { Db } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import type { DnsLookupFn } from './ssrf.js';
import type { Transport, FetchOutcome } from './fetch.js';
import { fetchPage } from './fetch.js';
import { type PageRenderer, decideRender, nullRenderer } from './render.js';
import { extractPage } from './html.js';
import { evaluatePage, type PageRecord } from './page-eval.js';
import { MemoryFrontier } from './frontier.js';
import { ConcurrencyLimiter, HostRateLimiter, withRetry } from './rate-limiter.js';
import { analyzeGraph, type GraphPage } from './link-graph.js';
import { runRules, type AuditContext, type IssueDraft } from './rules.js';
import { scoreCrawl } from './scoring.js';
import { matchRobots } from './robots.js';
import { CrawlSummary, type CrawlConfig } from './schemas.js';
import { isInScope, normalizeUrl } from './url.js';
import type { CrawlPlan } from './plan.js';
import { crawlingHalted } from './killswitch.js';

const log = createLogger('seo.crawler');

/** Widen a computed value for a Prisma `Json` column without a bare assertion. */
function asJson(value: unknown): object {
  return value as object;
}

export type ControlSignal = 'continue' | 'pause' | 'cancel';

export interface RunCrawlDeps {
  db: Db;
  lookup?: DnsLookupFn;
  transport?: Transport;
  renderer?: PageRenderer;
  now?: () => number;
  /** Polled between pages so a pause/cancel takes effect promptly. */
  checkControl?: () => Promise<ControlSignal> | ControlSignal;
  /** Called after each page with progress counters. */
  onProgress?: (p: { crawled: number; queued: number }) => void;
}

export interface RunCrawlResult {
  status: 'COMPLETED' | 'BLOCKED' | 'CANCELLED' | 'PAUSED' | 'FAILED';
  pagesCrawled: number;
  issuesFound: number;
  overallScore: number | null;
  summary: CrawlSummary | null;
}

export interface CrawlRow {
  id: string;
  organizationId: string;
  websiteId: string;
}

export async function runCrawl(
  crawl: CrawlRow,
  plan: CrawlPlan,
  deps: RunCrawlDeps,
): Promise<RunCrawlResult> {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());
  const renderer = deps.renderer ?? nullRenderer;
  const cfg = plan.config;
  const startedAt = now();
  const deadline = startedAt + cfg.maxDurationSec * 1000;

  await db.crawl.update({
    where: { id: crawl.id },
    data: { status: 'RUNNING', startedAt: new Date(startedAt), pauseRequested: false },
  });

  if (plan.blocked) {
    return finalizeBlocked(db, crawl, plan, 'robots.txt disallows all crawling for our user-agent');
  }
  if (crawlingHalted(crawl.organizationId)) {
    return finalizeBlocked(db, crawl, plan, 'crawling is halted by the operator kill switch');
  }

  const frontier = new MemoryFrontier(cfg.maxPages, cfg.maxDepth);
  for (const s of plan.seeds) frontier.add(s, 0, 'seed');
  // Sitemap URLs are discovery candidates at depth 1 (still scope + robots gated).
  for (const u of plan.sitemap.urls) {
    if (frontier.atCapacity()) break;
    if (inScopeAndAllowed(u, cfg, plan)) frontier.add(u, 1, 'sitemap');
  }

  const rateLimiter = new HostRateLimiter(cfg.crawlDelayMs);
  const pool = new ConcurrencyLimiter(cfg.concurrency);
  const pageRecords: PageRecord[] = [];
  const inFlight = new Set<Promise<void>>();

  let reachedTimeCap = false;
  let control: ControlSignal = 'continue';
  let processed = 0;

  const processOne = async (item: ReturnType<MemoryFrontier['next']>): Promise<void> => {
    if (!item) return;
    await pool.run(async () => {
      let host = '';
      try {
        host = new URL(item.normalizedUrl).host;
      } catch {
        return;
      }
      await rateLimiter.take(host);

      const robotsAllowed =
        !cfg.respectRobots ||
        !plan.robots.parsed ||
        matchRobots(plan.robots.parsed, pathOf(item.normalizedUrl), cfg.userAgent).allowed;

      const t0 = now();
      let outcome: FetchOutcome;
      try {
        outcome = await withRetry(
          () =>
            fetchPage(item.normalizedUrl, {
              lookup: deps.lookup,
              transport: deps.transport,
              userAgent: cfg.userAgent,
              maxBytes: cfg.maxResponseBytes,
              timeoutMs: 15_000,
            }),
          {
            retries: 2,
            baseDelayMs: 500,
            shouldRetry: (_e, attempt) => attempt <= 2,
          },
        );
      } catch (e) {
        outcome = {
          ok: false,
          reason: 'network',
          detail: e instanceof Error ? e.message : 'fetch threw',
          redirects: [],
        };
      }
      const responseTimeMs = now() - t0;

      let staticExtract = null as ReturnType<typeof extractPage> | null;
      let renderedExtract = null as ReturnType<typeof extractPage> | null;
      if (outcome.ok && outcome.isHtml && outcome.body) {
        staticExtract = extractPage(outcome.body, outcome.finalUrl);
        if (decideRender(cfg.renderMode, staticExtract) === 'render') {
          try {
            const r = await renderer.render(outcome.finalUrl, { timeoutMs: 15_000 });
            if (r.ok && r.html) renderedExtract = extractPage(r.html, outcome.finalUrl);
          } catch (e) {
            log.warn({ url: item.normalizedUrl, err: String(e) }, 'render failed');
          }
        }
      }

      const record = evaluatePage({
        requestedUrl: item.normalizedUrl,
        normalizedUrl: item.normalizedUrl,
        depth: item.depth,
        discoveredVia: item.discoveredVia,
        fetch: outcome,
        extracted: staticExtract,
        rendered: renderedExtract,
        responseTimeMs,
        robotsAllowed,
      });
      pageRecords.push(record);
      await persistPage(db, crawl, record);
      processed++;

      // Discover new links.
      if (outcome.ok && !frontier.atCapacity()) {
        const src = renderedExtract ?? staticExtract;
        const candidates = new Set<string>();
        for (const l of src?.links ?? []) {
          if (l.normalizedUrl && l.isInternal && !l.isNofollow) candidates.add(l.normalizedUrl);
        }
        if (src?.canonicalUrl) candidates.add(src.canonicalUrl);
        for (const h of src?.hreflang ?? []) {
          try {
            candidates.add(normalizeUrl(h.href));
          } catch {
            /* ignore */
          }
        }
        for (const hop of outcome.redirects) {
          try {
            candidates.add(normalizeUrl(hop.to));
          } catch {
            /* ignore */
          }
        }
        for (const c of candidates) {
          if (frontier.atCapacity()) break;
          if (!inScopeAndAllowed(c, cfg, plan)) continue;
          frontier.add(c, item.depth + 1, 'link');
        }
      }

      deps.onProgress?.({ crawled: processed, queued: frontier.pending });
    });
  };

  // Main scheduling loop with bounded concurrency.
  for (;;) {
    if (now() >= deadline) {
      reachedTimeCap = true;
      break;
    }
    if (deps.checkControl) {
      control = await deps.checkControl();
      if (control !== 'continue') break;
    }
    const item = frontier.next();
    if (!item) {
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
      continue;
    }
    const p = processOne(item).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= cfg.concurrency) await Promise.race(inFlight);
  }
  await Promise.allSettled(inFlight);

  if (control === 'cancel') {
    await db.crawl.update({
      where: { id: crawl.id },
      data: { status: 'CANCELLED', finishedAt: new Date(now()), cancelRequested: false },
    });
    return {
      status: 'CANCELLED',
      pagesCrawled: pageRecords.length,
      issuesFound: 0,
      overallScore: null,
      summary: null,
    };
  }
  if (control === 'pause') {
    await db.crawl.update({
      where: { id: crawl.id },
      data: { status: 'PAUSED', pauseRequested: false },
    });
    return {
      status: 'PAUSED',
      pagesCrawled: pageRecords.length,
      issuesFound: 0,
      overallScore: null,
      summary: null,
    };
  }

  // --- Finalize ---
  return finalize(db, crawl, plan, pageRecords, {
    durationSec: Math.round((now() - startedAt) / 1000),
    reachedPageCap: frontier.atCapacity(),
    reachedTimeCap,
  });
}

// --- helpers ---------------------------------------------------------

function pathOf(u: string): string {
  try {
    const url = new URL(u);
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}

function inScopeAndAllowed(url: string, cfg: CrawlConfig, plan: CrawlPlan): boolean {
  if (
    !isInScope(url, {
      registrableDomain: cfg.registrableDomain,
      additionalHosts: cfg.additionalHosts,
      includePaths: cfg.includePaths,
      excludePaths: cfg.excludePaths,
    })
  ) {
    return false;
  }
  if (cfg.respectRobots && plan.robots.parsed) {
    return matchRobots(plan.robots.parsed, pathOf(url), cfg.userAgent).allowed;
  }
  return true;
}

async function persistPage(db: Db, crawl: CrawlRow, r: PageRecord): Promise<void> {
  const data = {
    organizationId: crawl.organizationId,
    url: r.url,
    depth: r.depth,
    discoveredVia: r.discoveredVia,
    httpStatus: r.httpStatus,
    finalUrl: r.finalUrl,
    redirectChain: r.redirectChain as unknown as object,
    fetchError: r.fetchError,
    contentType: r.contentType,
    htmlBytes: r.htmlBytes,
    responseTimeMs: r.responseTimeMs,
    renderedWithJs: r.renderedWithJs,
    title: r.title,
    titleLength: r.titleLength,
    metaDescription: r.metaDescription,
    metaDescriptionLength: r.metaDescriptionLength,
    metaRobots: r.metaRobots,
    xRobotsTag: r.xRobotsTag,
    canonicalUrl: r.canonicalUrl,
    canonicalIsSelf: r.canonicalIsSelf,
    noindex: r.noindex,
    robotsBlocked: r.robotsBlocked,
    indexable: r.indexable,
    indexabilityReason: r.indexabilityReason,
    crawlable: r.crawlable,
    lang: r.lang,
    hreflang: r.hreflang as unknown as object,
    h1Count: r.h1Count,
    headingOutline: r.headingOutline as unknown as object,
    wordCount: r.wordCount,
    contentHash: r.contentHash,
    simhash: r.simhash,
    ogTags: r.ogTags as unknown as object,
    twitterTags: r.twitterTags as unknown as object,
    jsonLdTypes: r.jsonLdTypes,
    jsonLdErrors: r.jsonLdErrors as unknown as object,
    jsonLdEntities: r.jsonLdEntities as unknown as object,
    landmarkCount: r.landmarkCount,
    hasMainLandmark: r.hasMainLandmark,
    viewportMeta: r.viewportMeta,
    imagesTotal: r.imagesTotal,
    imagesMissingAlt: r.imagesMissingAlt,
    imagesMissingDim: r.imagesMissingDim,
    internalLinkCount: r.internalLinkCount,
    externalLinkCount: r.externalLinkCount,
    isHttps: r.isHttps,
    securityHeaders: r.securityHeaders as unknown as object,
    mixedContent: r.mixedContent,
    csrLikely: r.csrLikely,
    staticWordCount: r.staticWordCount,
    renderedWordCount: r.renderedWordCount,
  };

  const page = await db.crawlPage.upsert({
    where: { crawlId_normalizedUrl: { crawlId: crawl.id, normalizedUrl: r.normalizedUrl } },
    create: { crawlId: crawl.id, normalizedUrl: r.normalizedUrl, ...data },
    update: data,
  });

  if (r.outboundLinks.length > 0) {
    await db.crawlLink.deleteMany({ where: { fromPageId: page.id } });
    await db.crawlLink.createMany({
      data: r.outboundLinks.slice(0, 3000).map((l) => ({
        crawlId: crawl.id,
        organizationId: crawl.organizationId,
        fromPageId: page.id,
        toNormalizedUrl: l.toNormalizedUrl,
        isInternal: l.isInternal,
        isNofollow: l.isNofollow,
        rel: l.rel,
        anchorText: l.anchorText.slice(0, 300),
      })),
    });
  }
}

async function finalizeBlocked(
  db: Db,
  crawl: CrawlRow,
  plan: CrawlPlan,
  reason: string,
): Promise<RunCrawlResult> {
  await db.crawl.update({
    where: { id: crawl.id },
    data: { status: 'BLOCKED', blockedReason: reason, finishedAt: new Date() },
  });
  await db.crawlIssue
    .create({
      data: {
        crawlId: crawl.id,
        websiteId: crawl.websiteId,
        organizationId: crawl.organizationId,
        code: plan.blocked ? 'ROBOTS_FULL_DISALLOW' : 'CRAWLING_HALTED',
        category: 'crawlability',
        severity: 'CRITICAL',
        title: plan.blocked ? 'robots.txt disallows all crawling' : 'Crawling halted',
        detail: reason,
        recommendedFix: plan.blocked
          ? 'Relax the robots.txt Disallow rules if the site should be crawlable. We did not evade the block.'
          : 'Contact support — crawling is temporarily disabled.',
        confidence: 1,
        evidence: {},
      },
    })
    .catch(() => undefined);
  return {
    status: 'BLOCKED',
    pagesCrawled: 0,
    issuesFound: plan.blocked ? 1 : 0,
    overallScore: null,
    summary: null,
  };
}

/** Bounded concurrency for the two `finalize()` persistence loops below —
 * high enough to erase most of the network-round-trip latency of writing
 * one row at a time, bounded so a large crawl doesn't open thousands of
 * concurrent connections against the pool. */
const FINALIZE_WRITE_CONCURRENCY = 10;

/**
 * Write each page's inbound-internal-link count (used by the AI SEO agent's
 * internal-link tools and the "thin internal linking" views). Exported for
 * direct unit testing; a failed row is swallowed exactly as `finalize()`
 * always did, so one bad row never aborts the batch.
 */
export async function persistInboundLinkCounts(
  db: Db,
  crawlId: string,
  pageRecords: PageRecord[],
  inboundCountByUrl: Map<string, number>,
): Promise<void> {
  const limiter = new ConcurrencyLimiter(FINALIZE_WRITE_CONCURRENCY);
  await Promise.all(
    pageRecords.map((p) =>
      limiter.run(async () => {
        const inbound = inboundCountByUrl.get(p.normalizedUrl) ?? 0;
        await db.crawlPage
          .update({
            where: { crawlId_normalizedUrl: { crawlId, normalizedUrl: p.normalizedUrl } },
            data: { inboundInternalCount: inbound },
          })
          .catch(() => undefined);
      }),
    ),
  );
}

/**
 * Persist the auditor's issue drafts (identity: crawlId + code + normalizedUrl).
 * Exported for direct unit testing; a failed upsert is logged and swallowed
 * exactly as `finalize()` always did, so one bad row never aborts the batch.
 */
export async function persistCrawlIssues(
  db: Db,
  crawl: CrawlRow,
  issues: IssueDraft[],
): Promise<void> {
  const limiter = new ConcurrencyLimiter(FINALIZE_WRITE_CONCURRENCY);
  await Promise.all(
    issues.map((issue) =>
      limiter.run(async () => {
        const pageId = issue.normalizedUrl
          ? ((
              await db.crawlPage.findUnique({
                where: {
                  crawlId_normalizedUrl: { crawlId: crawl.id, normalizedUrl: issue.normalizedUrl },
                },
                select: { id: true },
              })
            )?.id ?? null)
          : null;
        await db.crawlIssue
          .upsert({
            where: {
              crawlId_code_normalizedUrl: {
                crawlId: crawl.id,
                code: issue.code,
                normalizedUrl: issue.normalizedUrl ?? '',
              },
            },
            create: {
              crawlId: crawl.id,
              websiteId: crawl.websiteId,
              organizationId: crawl.organizationId,
              code: issue.code,
              category: issue.category,
              severity: issue.severity,
              pageId,
              normalizedUrl: issue.normalizedUrl,
              title: issue.title,
              detail: issue.detail,
              evidence: asJson(issue.evidence),
              recommendedFix: issue.recommendedFix,
              confidence: issue.confidence,
              affectedUrlCount: issue.affectedUrlCount,
            },
            update: {
              severity: issue.severity,
              detail: issue.detail,
              evidence: asJson(issue.evidence),
              affectedUrlCount: issue.affectedUrlCount,
            },
          })
          .catch((e) => log.warn({ code: issue.code, err: String(e) }, 'issue persist failed'));
      }),
    ),
  );
}

async function finalize(
  db: Db,
  crawl: CrawlRow,
  plan: CrawlPlan,
  pageRecords: PageRecord[],
  meta: { durationSec: number; reachedPageCap: boolean; reachedTimeCap: boolean },
): Promise<RunCrawlResult> {
  const cfg = plan.config;
  const graphPages: GraphPage[] = pageRecords.map((p) => ({
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
  }));

  const graph = analyzeGraph({
    pages: graphPages,
    seeds: plan.seeds,
    sitemapUrls: plan.sitemap.urls,
    maxDepth: cfg.maxDepth,
  });

  // Sitemap coverage cross-check.
  const crawledSet = new Set(pageRecords.map((p) => p.normalizedUrl));
  const indexableCrawled = new Set(
    pageRecords.filter((p) => p.indexable).map((p) => p.normalizedUrl),
  );
  const sitemapSet = new Set(plan.sitemap.urls);
  const inSitemapNotCrawled = [...sitemapSet].filter((u) => !crawledSet.has(u));
  const crawledNotInSitemap = [...indexableCrawled].filter((u) => !sitemapSet.has(u));
  const nonIndexableInSitemap = [...sitemapSet].filter((u) => {
    const p = pageRecords.find((x) => x.normalizedUrl === u);
    return p ? !p.indexable : false;
  });

  const importantPathsBlocked =
    cfg.respectRobots && plan.robots.parsed
      ? [...sitemapSet]
          .map((u) => pathOf(u))
          .filter((path) => !matchRobots(plan.robots.parsed!, path, cfg.userAgent).allowed)
          .slice(0, 50)
          .map((path) => ({ path, rule: { type: 'disallow', path } }))
      : [];

  const auditCtx: AuditContext = {
    pages: pageRecords,
    graph,
    config: cfg,
    robots: {
      present: plan.robots.present,
      parsed: plan.robots.parsed,
      fullyDisallowed: plan.robots.fullyDisallowed,
      importantPathsBlocked,
    },
    sitemap: {
      declaredCount: plan.sitemap.declaredUrls.length,
      urls: plan.sitemap.urls,
      issues: plan.sitemap.issues,
      inSitemapNotCrawled,
      crawledNotInSitemap,
      nonIndexableInSitemap,
    },
  };

  const issues = runRules(auditCtx);
  const score = scoreCrawl(issues, pageRecords.length);

  await persistInboundLinkCounts(db, crawl.id, pageRecords, graph.inboundCountByUrl);
  await persistCrawlIssues(db, crawl, issues);

  const statusClass: Record<string, number> = {};
  const depthHist: Record<string, number> = {};
  let responseSum = 0;
  let responseN = 0;
  for (const p of pageRecords) {
    const cls = p.httpStatus == null ? 'error' : `${Math.floor(p.httpStatus / 100)}xx`;
    statusClass[cls] = (statusClass[cls] ?? 0) + 1;
    const d = graph.depthByUrl.get(p.normalizedUrl);
    const key = d == null ? 'unreachable' : String(d);
    depthHist[key] = (depthHist[key] ?? 0) + 1;
    if (p.responseTimeMs != null) {
      responseSum += p.responseTimeMs;
      responseN++;
    }
  }

  const summary: CrawlSummary = CrawlSummary.parse({
    totalPages: pageRecords.length,
    byStatusClass: statusClass,
    byDepth: depthHist,
    indexablePages: pageRecords.filter((p) => p.indexable).length,
    nonIndexablePages: pageRecords.filter((p) => !p.indexable).length,
    orphanPages: graph.orphanPages.length,
    brokenInternalLinks: graph.brokenInternalLinks.length,
    redirectChains: graph.redirectChains.length,
    redirectLoops: graph.redirectLoops.length,
    duplicateTitleGroups: graph.duplicateTitleGroups.length,
    duplicateContentClusters: graph.duplicateContentClusters.length,
    sitemap: {
      declared: plan.sitemap.declaredUrls.length,
      urls: plan.sitemap.urls.length,
      inSitemapNotCrawled: inSitemapNotCrawled.length,
      crawledNotInSitemap: crawledNotInSitemap.length,
      nonIndexableInSitemap: nonIndexableInSitemap.length,
    },
    robots: {
      present: plan.robots.present,
      fullyDisallowed: plan.robots.fullyDisallowed,
      syntaxIssues: plan.robots.parsed?.issues.length ?? 0,
      importantPathsBlocked: importantPathsBlocked.length,
    },
    renderedPages: pageRecords.filter((p) => p.renderedWithJs).length,
    averageResponseMs: responseN > 0 ? Math.round(responseSum / responseN) : null,
    crawlDurationSec: meta.durationSec,
    reachedPageCap: meta.reachedPageCap,
    reachedTimeCap: meta.reachedTimeCap,
    blocked: false,
  });

  await db.crawl.update({
    where: { id: crawl.id },
    data: {
      status: 'COMPLETED',
      finishedAt: new Date(),
      pagesCrawled: pageRecords.length,
      pagesQueued: 0,
      issuesFound: issues.length,
      summary: asJson(summary),
      scores: asJson(score),
    },
  });

  return {
    status: 'COMPLETED',
    pagesCrawled: pageRecords.length,
    issuesFound: issues.length,
    overallScore: score.overall,
    summary,
  };
}
