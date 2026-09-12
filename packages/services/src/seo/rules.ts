/**
 * The technical auditor rule catalogue (docs/SEO-ENGINE.md §3, "ISSUE SYSTEM").
 * Each rule inspects the crawl output and emits zero or more `IssueDraft`s.
 * Codes are stable slugs; issue identity across crawls is
 * `(websiteId, code, normalizedUrl?)`.
 *
 * Rules never assert a ranking outcome — they explain crawl-efficiency and
 * machine-readability impact only.
 */
import type { GraphAnalysis } from './link-graph.js';
import type { PageRecord } from './page-eval.js';
import type { ParsedRobots } from './robots.js';
import type { CrawlConfig, IssueCategory, IssueSeverity } from './schemas.js';

export interface IssueDraft {
  code: string;
  category: IssueCategory;
  severity: IssueSeverity;
  normalizedUrl: string | null;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  recommendedFix: string;
  confidence: number;
  affectedUrlCount: number;
}

export interface AuditContext {
  pages: PageRecord[];
  graph: GraphAnalysis;
  config: CrawlConfig;
  robots: {
    present: boolean;
    parsed: ParsedRobots | null;
    fullyDisallowed: boolean;
    importantPathsBlocked: Array<{ path: string; rule: { type: string; path: string } }>;
  };
  sitemap: {
    declaredCount: number;
    urls: string[];
    issues: Array<{ code: string; detail: string }>;
    inSitemapNotCrawled: string[];
    crawledNotInSitemap: string[];
    nonIndexableInSitemap: string[];
  };
}

type Rule = (ctx: AuditContext) => IssueDraft[];

const TITLE_MIN = 15;
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;
const SLOW_MS = 1500;
const LARGE_HTML = 2 * 1024 * 1024;

function draft(
  p: Partial<IssueDraft> & Pick<IssueDraft, 'code' | 'category' | 'severity' | 'title'>,
): IssueDraft {
  return {
    normalizedUrl: null,
    detail: '',
    evidence: {},
    recommendedFix: '',
    confidence: 0.85,
    affectedUrlCount: 1,
    ...p,
  };
}

const successHtmlPages = (ctx: AuditContext): PageRecord[] =>
  ctx.pages.filter((p) => p.httpStatus != null && p.httpStatus >= 200 && p.httpStatus < 300);

// --- Crawlability / status / redirects ---------------------------------

const rBlocked: Rule = (ctx) =>
  ctx.robots.fullyDisallowed
    ? [
        draft({
          code: 'ROBOTS_FULL_DISALLOW',
          category: 'crawlability',
          severity: 'CRITICAL',
          title: 'robots.txt disallows all crawling',
          detail:
            'The site’s robots.txt blocks our user-agent from every path. Search engines that honour it will not crawl the site either.',
          recommendedFix:
            'If the site should be indexed, relax the Disallow rules for the relevant crawlers. We did not evade the block.',
          evidence: { fullyDisallowed: true },
          confidence: 0.99,
        }),
      ]
    : [];

const rServerErrors: Rule = (ctx) => {
  const errs = ctx.pages.filter((p) => p.httpStatus != null && p.httpStatus >= 500);
  return errs.map((p) =>
    draft({
      code: 'SERVER_ERROR',
      category: 'crawlability',
      severity: 'HIGH',
      normalizedUrl: p.normalizedUrl,
      title: `Server error (HTTP ${p.httpStatus})`,
      detail: `${p.normalizedUrl} returned HTTP ${p.httpStatus}. Crawlers repeatedly hitting 5xx responses slow down crawling of the whole site.`,
      recommendedFix: 'Investigate the server error and return a 200 (or an intentional 404/410).',
      evidence: { status: p.httpStatus, error: p.fetchError },
    }),
  );
};

const rBrokenInternal: Rule = (ctx) => {
  const grouped = new Map<string, { from: string[]; status: number | null }>();
  for (const b of ctx.graph.brokenInternalLinks) {
    const g = grouped.get(b.to) ?? { from: [], status: b.status };
    g.from.push(b.from);
    grouped.set(b.to, g);
  }
  return [...grouped.entries()].map(([to, g]) =>
    draft({
      code: 'BROKEN_INTERNAL_LINK',
      category: 'crawlability',
      severity: 'HIGH',
      normalizedUrl: to,
      title: `Broken internal link (HTTP ${g.status ?? '4xx'})`,
      detail: `${g.from.length} internal link(s) point to ${to}, which returns HTTP ${g.status ?? '4xx'}.`,
      recommendedFix: 'Fix or remove the links, or restore the target URL.',
      evidence: { linkedFrom: g.from.slice(0, 20), status: g.status },
      affectedUrlCount: g.from.length,
    }),
  );
};

const rRedirectChain: Rule = (ctx) =>
  ctx.graph.redirectChains.map((c) =>
    draft({
      code: 'REDIRECT_CHAIN',
      category: 'crawlability',
      severity: 'MEDIUM',
      normalizedUrl: c.url,
      title: `Redirect chain (${c.hops} hops)`,
      detail: `Reaching ${c.url} takes ${c.hops} redirect hops. Each hop costs crawl budget and a little latency; some crawlers stop following after a few.`,
      recommendedFix: 'Point the first URL directly at the final destination (one 301).',
      evidence: { hops: c.hops },
      confidence: 0.9,
    }),
  );

const rRedirectLoop: Rule = (ctx) =>
  ctx.graph.redirectLoops.map((u) =>
    draft({
      code: 'REDIRECT_LOOP',
      category: 'crawlability',
      severity: 'HIGH',
      normalizedUrl: u,
      title: 'Redirect loop',
      detail: `${u} redirects in a cycle and never resolves to a final page.`,
      recommendedFix: 'Break the cycle so the URL ends at a single 200 response.',
      confidence: 0.95,
    }),
  );

const rFetchFailures: Rule = (ctx) => {
  const failed = ctx.pages.filter((p) => p.fetchError && p.httpStatus == null);
  return failed.map((p) =>
    draft({
      code: 'FETCH_FAILED',
      category: 'crawlability',
      severity: 'MEDIUM',
      normalizedUrl: p.normalizedUrl,
      title: 'Page could not be fetched',
      detail: `${p.normalizedUrl}: ${p.fetchError}.`,
      recommendedFix:
        'Check that the URL is reachable over the public internet without authentication and within the timeout.',
      evidence: { error: p.fetchError },
      confidence: 0.7,
    }),
  );
};

// --- Indexability -----------------------------------------------------

const rNoindexOnLinked: Rule = (ctx) => {
  const out: IssueDraft[] = [];
  for (const p of ctx.pages) {
    if (!p.noindex) continue;
    const inbound = ctx.graph.inboundCountByUrl.get(p.normalizedUrl) ?? 0;
    if (inbound >= 3) {
      out.push(
        draft({
          code: 'NOINDEX_ON_LINKED_PAGE',
          category: 'indexability',
          severity: 'HIGH',
          normalizedUrl: p.normalizedUrl,
          title: 'Well-linked page is set to noindex',
          detail: `${p.normalizedUrl} has ${inbound} internal links pointing to it but is excluded from indexing (${p.indexabilityReason ?? 'noindex'}). If that is unintentional the page will not appear in search or AI answers.`,
          recommendedFix:
            'Remove the noindex directive if the page should be indexable; otherwise consider unlinking it from primary navigation.',
          evidence: { inbound, reason: p.indexabilityReason },
          confidence: 0.75,
        }),
      );
    }
  }
  return out;
};

const rRobotsBlocksImportant: Rule = (ctx) =>
  ctx.robots.importantPathsBlocked.map((b) =>
    draft({
      code: 'ROBOTS_BLOCKS_IMPORTANT_PATH',
      category: 'indexability',
      severity: 'HIGH',
      normalizedUrl: null,
      title: 'robots.txt blocks a path that looks important',
      detail: `robots.txt rule "${b.rule.type}: ${b.rule.path}" blocks ${b.path}, which appears in the sitemap or navigation.`,
      recommendedFix: 'Confirm the block is intentional; if not, adjust the Disallow rule.',
      evidence: { path: b.path, rule: b.rule },
      confidence: 0.7,
    }),
  );

const rCanonicalToNonCanonical: Rule = (ctx) =>
  ctx.graph.canonicalConflicts.map((c) =>
    draft({
      code: 'CANONICAL_CONFLICT',
      category: 'indexability',
      severity: 'MEDIUM',
      normalizedUrl: c.url,
      title: 'Canonical conflict',
      detail: `${c.url} declares a canonical of ${c.canonicalUrl}, but ${c.problem}.`,
      recommendedFix: 'Point the canonical at a single, indexable, self-canonical 200 URL.',
      evidence: { canonicalUrl: c.canonicalUrl, problem: c.problem },
      confidence: 0.8,
    }),
  );

const rParamIndexable: Rule = (ctx) =>
  ctx.graph.parameterExplosionPaths.map((p) =>
    draft({
      code: 'EXCESSIVE_PARAMETERS',
      category: 'indexability',
      severity: 'MEDIUM',
      normalizedUrl: null,
      title: 'Many parameter variants of one path',
      detail: `${p.path} was crawled with ${p.variants} distinct query-string combinations. Faceted/parameter URLs can dilute crawl budget and create duplicates.`,
      recommendedFix:
        'Consolidate with canonical tags, robots rules, or the URL Parameters approach; keep only useful, indexable variants.',
      evidence: p,
      affectedUrlCount: p.variants,
      confidence: 0.65,
    }),
  );

// --- Duplication -----------------------------------------------------

const dupRule =
  (
    code: string,
    title: string,
    field:
      | 'duplicateTitleGroups'
      | 'duplicateDescriptionGroups'
      | 'duplicateContentClusters'
      | 'duplicateUrlVariants',
    severity: IssueSeverity,
    fix: string,
  ): Rule =>
  (ctx) =>
    ctx.graph[field].map((g) =>
      draft({
        code,
        category:
          field === 'duplicateContentClusters' || field === 'duplicateUrlVariants'
            ? 'indexability'
            : 'metadata',
        severity,
        normalizedUrl: g.urls[0] ?? null,
        title,
        detail: `${g.urls.length} pages share ${
          field === 'duplicateTitleGroups'
            ? `the title "${g.key.slice(0, 80)}"`
            : field === 'duplicateDescriptionGroups'
              ? 'the same meta description'
              : 'effectively identical content'
        }.`,
        recommendedFix: fix,
        evidence: { urls: g.urls.slice(0, 25), count: g.urls.length },
        affectedUrlCount: g.urls.length,
        confidence: field === 'duplicateContentClusters' ? 0.7 : 0.85,
      }),
    );

const rDupTitle = dupRule(
  'DUPLICATE_TITLE',
  'Duplicate <title> across pages',
  'duplicateTitleGroups',
  'MEDIUM',
  'Give each page a unique, descriptive title.',
);
const rDupDesc = dupRule(
  'DUPLICATE_META_DESCRIPTION',
  'Duplicate meta description across pages',
  'duplicateDescriptionGroups',
  'LOW',
  'Write a unique meta description per page, or remove it and let search engines generate one.',
);
const rDupContent = dupRule(
  'DUPLICATE_CONTENT_CLUSTER',
  'Near-duplicate content cluster',
  'duplicateContentClusters',
  'MEDIUM',
  'Consolidate the duplicates, or use canonical tags to nominate one primary URL.',
);
const rDupUrlVariants = dupRule(
  'DUPLICATE_URL_VARIANTS',
  'Multiple URLs serve identical content',
  'duplicateUrlVariants',
  'MEDIUM',
  'Pick one canonical URL and 301 or canonical-tag the rest.',
);

// --- Architecture --------------------------------------------------

const rOrphan: Rule = (ctx) =>
  ctx.graph.orphanPages.map((u) =>
    draft({
      code: 'ORPHAN_PAGE',
      category: 'architecture',
      severity: 'MEDIUM',
      normalizedUrl: u,
      title: 'Orphan page (no internal links)',
      detail: `${u} is known (sitemap / discovered) but no crawled page links to it, so crawlers and users can only reach it directly.`,
      recommendedFix: 'Link to it from a relevant category, hub, or navigation element.',
      confidence: 0.75,
    }),
  );

const rNoInbound: Rule = (ctx) => {
  const onlyNoInbound = ctx.graph.noInboundPages.filter((u) => !ctx.graph.orphanPages.includes(u));
  return onlyNoInbound.map((u) =>
    draft({
      code: 'THIN_INTERNAL_LINKING',
      category: 'internal_linking',
      severity: 'LOW',
      normalizedUrl: u,
      title: 'Page has no inbound internal links',
      detail: `${u} was reached via a redirect or the sitemap but has no inbound internal links from other content.`,
      recommendedFix: 'Add contextual internal links from related pages.',
      confidence: 0.6,
    }),
  );
};

const rExcessiveDepth: Rule = (ctx) =>
  ctx.graph.excessiveDepthPages.map((u) =>
    draft({
      code: 'EXCESSIVE_CRAWL_DEPTH',
      category: 'architecture',
      severity: 'LOW',
      normalizedUrl: u,
      title: 'Page is deep in the click path',
      detail: `${u} sits more than ${ctx.config.maxDepth} clicks from the start URL. Deep pages are crawled less often.`,
      recommendedFix:
        'Flatten the structure — add hub pages or navigation links closer to the home page.',
      confidence: 0.6,
    }),
  );

const rExcessiveUrlDepth: Rule = (ctx) =>
  ctx.graph.excessiveUrlDepthPages.map((u) =>
    draft({
      code: 'EXCESSIVE_URL_DEPTH',
      category: 'architecture',
      severity: 'INFO',
      normalizedUrl: u,
      title: 'Deeply nested URL path',
      detail: `${u} has a long path. Deep paths are not a ranking problem by themselves but often signal a structure worth reviewing.`,
      recommendedFix: 'Consider a shallower, more predictable URL structure.',
      confidence: 0.5,
    }),
  );

// --- Metadata & semantics ---------------------------------------

const rMissingTitle: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter((p) => !p.title)
    .map((p) =>
      draft({
        code: 'MISSING_TITLE',
        category: 'metadata',
        severity: 'HIGH',
        normalizedUrl: p.normalizedUrl,
        title: 'Missing <title>',
        detail: `${p.normalizedUrl} has no <title>. It is the primary label in search results and AI citations.`,
        recommendedFix: 'Add a unique, descriptive <title> (roughly 15–60 characters).',
      }),
    );

const rTitleLength: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter(
      (p) => p.titleLength != null && (p.titleLength < TITLE_MIN || p.titleLength > TITLE_MAX),
    )
    .map((p) =>
      draft({
        code: 'TITLE_LENGTH',
        category: 'metadata',
        severity: 'LOW',
        normalizedUrl: p.normalizedUrl,
        title: `Title is ${p.titleLength! < TITLE_MIN ? 'very short' : 'long'} (${p.titleLength} chars)`,
        detail: `${p.normalizedUrl} has a ${p.titleLength}-character title. Long titles are truncated in results; very short ones under-describe the page.`,
        recommendedFix: `Aim for roughly ${TITLE_MIN}–${TITLE_MAX} characters.`,
        confidence: 0.6,
      }),
    );

const rMissingDesc: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter((p) => p.indexable && !p.metaDescription)
    .map((p) =>
      draft({
        code: 'MISSING_META_DESCRIPTION',
        category: 'metadata',
        severity: 'LOW',
        normalizedUrl: p.normalizedUrl,
        title: 'Missing meta description',
        detail: `${p.normalizedUrl} has no meta description, so search engines will synthesise the snippet.`,
        recommendedFix: `Add a ${DESC_MIN}–${DESC_MAX} character summary, or intentionally omit it.`,
        confidence: 0.55,
      }),
    );

const rDescLength: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter(
      (p) =>
        p.metaDescriptionLength != null &&
        (p.metaDescriptionLength < DESC_MIN || p.metaDescriptionLength > DESC_MAX),
    )
    .map((p) =>
      draft({
        code: 'META_DESCRIPTION_LENGTH',
        category: 'metadata',
        severity: 'INFO',
        normalizedUrl: p.normalizedUrl,
        title: `Meta description length (${p.metaDescriptionLength} chars)`,
        detail: `${p.normalizedUrl} has a ${p.metaDescriptionLength}-character meta description.`,
        recommendedFix: `Aim for roughly ${DESC_MIN}–${DESC_MAX} characters.`,
        confidence: 0.5,
      }),
    );

const rH1: Rule = (ctx) => {
  const out: IssueDraft[] = [];
  for (const p of successHtmlPages(ctx)) {
    if (p.h1Count === 0) {
      out.push(
        draft({
          code: 'MISSING_H1',
          category: 'metadata',
          severity: 'LOW',
          normalizedUrl: p.normalizedUrl,
          title: 'No <h1> on the page',
          detail: `${p.normalizedUrl} has no <h1>, weakening the page's topical signal.`,
          recommendedFix: 'Add a single descriptive <h1>.',
          confidence: 0.7,
        }),
      );
    } else if (p.h1Count > 1) {
      out.push(
        draft({
          code: 'MULTIPLE_H1',
          category: 'metadata',
          severity: 'INFO',
          normalizedUrl: p.normalizedUrl,
          title: `Multiple <h1> elements (${p.h1Count})`,
          detail: `${p.normalizedUrl} has ${p.h1Count} <h1> elements. Modern parsers tolerate this, but a single <h1> is clearer.`,
          recommendedFix: 'Use one <h1> and demote the rest to <h2>/<h3>.',
          confidence: 0.5,
        }),
      );
    }
  }
  return out;
};

const rHeadingOrder: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter((p) => p.headingOutline.length > 2 && !isOrdered(p.headingOutline))
    .map((p) =>
      draft({
        code: 'HEADING_ORDER',
        category: 'metadata',
        severity: 'INFO',
        normalizedUrl: p.normalizedUrl,
        title: 'Heading levels skip',
        detail: `${p.normalizedUrl} jumps heading levels (e.g. <h2> → <h4>), which hurts outline clarity for assistive tech and parsers.`,
        recommendedFix: 'Use heading levels sequentially.',
        confidence: 0.6,
      }),
    );

const rImgAlt: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter((p) => p.imagesMissingAlt > 0)
    .map((p) =>
      draft({
        code: 'MISSING_IMAGE_ALT',
        category: 'metadata',
        severity: 'LOW',
        normalizedUrl: p.normalizedUrl,
        title: `${p.imagesMissingAlt} image(s) missing alt text`,
        detail: `${p.normalizedUrl} has ${p.imagesMissingAlt} of ${p.imagesTotal} images with no alt attribute.`,
        recommendedFix: 'Add descriptive alt text (empty alt="" for decorative images).',
        evidence: { missing: p.imagesMissingAlt, total: p.imagesTotal },
        affectedUrlCount: 1,
        confidence: 0.8,
      }),
    );

const rNoViewport: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter((p) => !p.viewportMeta)
    .map((p) =>
      draft({
        code: 'NO_VIEWPORT_META',
        category: 'performance',
        severity: 'LOW',
        normalizedUrl: p.normalizedUrl,
        title: 'No viewport meta tag',
        detail: `${p.normalizedUrl} has no <meta name="viewport">, so it may not render well on mobile — a signal search engines use.`,
        recommendedFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        confidence: 0.85,
      }),
    );

const rNoLandmarks: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter(
      (p) =>
        p.indexable &&
        p.wordCount != null &&
        p.wordCount > 120 &&
        !p.hasMainLandmark &&
        p.landmarkCount < 2,
    )
    .slice(0, 200)
    .map((p) =>
      draft({
        code: 'NO_SEMANTIC_LANDMARKS',
        category: 'structured_data',
        severity: 'LOW',
        normalizedUrl: p.normalizedUrl,
        title: 'No semantic landmark elements',
        detail: `${p.normalizedUrl} uses few or no HTML landmark elements (<main>, <nav>, <header>, <article>…). Landmarks let assistive tech, parsers and AI agents identify the primary content region.`,
        recommendedFix:
          'Wrap the primary content in <main>, and use <nav>/<header>/<footer>/<article> for the surrounding structure.',
        evidence: { landmarkCount: p.landmarkCount, hasMainLandmark: p.hasMainLandmark },
        confidence: 0.6,
      }),
    );

// --- Structured data ---------------------------------------------

const rInvalidJsonLd: Rule = (ctx) =>
  ctx.pages
    .filter((p) => p.jsonLdErrors.length > 0)
    .map((p) =>
      draft({
        code: 'INVALID_JSONLD',
        category: 'structured_data',
        severity: 'MEDIUM',
        normalizedUrl: p.normalizedUrl,
        title: 'Invalid JSON-LD block',
        detail: `${p.normalizedUrl} has ${p.jsonLdErrors.length} JSON-LD script(s) that fail to parse, so that structured data is ignored.`,
        recommendedFix: 'Fix the JSON syntax; validate with a structured-data testing tool.',
        evidence: { errors: p.jsonLdErrors },
        confidence: 0.9,
      }),
    );

const rNoStructuredData: Rule = (ctx) => {
  const pages = successHtmlPages(ctx).filter((p) => p.indexable);
  const without = pages.filter((p) => p.jsonLdTypes.length === 0);
  if (pages.length < 5 || without.length < pages.length * 0.6) return [];
  return [
    draft({
      code: 'NO_STRUCTURED_DATA',
      category: 'structured_data',
      severity: 'LOW',
      normalizedUrl: null,
      title: 'Little or no structured data across the site',
      detail: `${without.length} of ${pages.length} indexable pages have no JSON-LD. Structured data helps search engines and AI systems understand entities on the page. We do not claim rich-result eligibility — that depends on Google’s own rules.`,
      recommendedFix:
        'Add relevant schema.org types (Organization, Article, Product, BreadcrumbList) as JSON-LD.',
      evidence: { withoutCount: without.length, total: pages.length },
      affectedUrlCount: without.length,
      confidence: 0.55,
    }),
  ];
};

const rOgIncomplete: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter(
      (p) =>
        p.indexable &&
        !(p.ogTags['og:title'] && p.ogTags['og:description'] && p.ogTags['og:image']),
    )
    .slice(0, 200)
    .map((p) =>
      draft({
        code: 'OG_TAGS_INCOMPLETE',
        category: 'structured_data',
        severity: 'INFO',
        normalizedUrl: p.normalizedUrl,
        title: 'Incomplete Open Graph tags',
        detail: `${p.normalizedUrl} is missing one or more of og:title / og:description / og:image, so shared links render poorly.`,
        recommendedFix: 'Add the core Open Graph tags (and twitter:card for X).',
        evidence: { present: Object.keys(p.ogTags) },
        confidence: 0.6,
      }),
    );

// --- Rendering & performance ----------------------------------

const rSlow: Rule = (ctx) =>
  ctx.pages
    .filter((p) => p.responseTimeMs != null && p.responseTimeMs > SLOW_MS)
    .map((p) =>
      draft({
        code: 'SLOW_RESPONSE',
        category: 'performance',
        severity: 'MEDIUM',
        normalizedUrl: p.normalizedUrl,
        title: `Slow server response (${p.responseTimeMs} ms)`,
        detail: `${p.normalizedUrl} took ${p.responseTimeMs} ms to respond (time to first byte). Slow responses reduce how much of the site gets crawled.`,
        recommendedFix: 'Investigate server-side latency, caching, and CDN coverage.',
        evidence: { responseTimeMs: p.responseTimeMs },
        confidence: 0.8,
      }),
    );

const rLargeHtml: Rule = (ctx) =>
  ctx.pages
    .filter((p) => p.htmlBytes != null && p.htmlBytes > LARGE_HTML)
    .map((p) =>
      draft({
        code: 'LARGE_HTML',
        category: 'performance',
        severity: 'LOW',
        normalizedUrl: p.normalizedUrl,
        title: `Large HTML document (${Math.round((p.htmlBytes ?? 0) / 1024)} KB)`,
        detail: `${p.normalizedUrl} delivers a very large HTML payload, slowing parsing and rendering.`,
        recommendedFix: 'Trim inlined data, paginate, or lazy-load below-the-fold content.',
        confidence: 0.7,
      }),
    );

const rCsrOnly: Rule = (ctx) =>
  ctx.pages
    .filter((p) => p.csrLikely)
    .map((p) =>
      draft({
        code: 'CONTENT_REQUIRES_JS',
        category: 'performance',
        severity: 'HIGH',
        normalizedUrl: p.normalizedUrl,
        title: 'Main content appears to require JavaScript',
        detail: `${p.normalizedUrl} has little content in the initial HTML (${p.staticWordCount ?? 0} words) and relies on client-side rendering. Crawlers and AI systems that do not execute JS will see an near-empty page.`,
        recommendedFix:
          'Server-render or pre-render the primary content so it is present in the initial HTML.',
        evidence: { staticWordCount: p.staticWordCount, renderedWordCount: p.renderedWordCount },
        confidence: p.renderedWordCount != null ? 0.85 : 0.6,
      }),
    );

// --- Security ---------------------------------------------------

const rHttpsMissing: Rule = (ctx) =>
  ctx.pages
    .filter((p) => p.finalUrl && p.finalUrl.startsWith('http://'))
    .map((p) =>
      draft({
        code: 'HTTP_NOT_HTTPS',
        category: 'security',
        severity: 'HIGH',
        normalizedUrl: p.normalizedUrl,
        title: 'Page served over HTTP',
        detail: `${p.finalUrl} is not served over HTTPS. Browsers mark it "Not secure" and search engines prefer HTTPS.`,
        recommendedFix: 'Serve the whole site over HTTPS and 301-redirect HTTP to HTTPS.',
        confidence: 0.95,
      }),
    );

const rMixedContent: Rule = (ctx) =>
  ctx.pages
    .filter((p) => p.mixedContent)
    .map((p) =>
      draft({
        code: 'MIXED_CONTENT',
        category: 'security',
        severity: 'MEDIUM',
        normalizedUrl: p.normalizedUrl,
        title: 'Mixed content (HTTP links on an HTTPS page)',
        detail: `${p.normalizedUrl} is HTTPS but references http:// resources, which browsers block or downgrade.`,
        recommendedFix: 'Update the references to https:// (or protocol-relative).',
        confidence: 0.75,
      }),
    );

const rSecurityHeaders: Rule = (ctx) => {
  const pages = successHtmlPages(ctx);
  if (pages.length === 0) return [];
  const sample = pages[0]!;
  const sec = sample.securityHeaders;
  if (!sec || !('hsts' in sec)) return [];
  const out: IssueDraft[] = [];
  if (sample.isHttps && !sec.hsts) {
    out.push(
      draft({
        code: 'MISSING_HSTS',
        category: 'security',
        severity: 'LOW',
        normalizedUrl: null,
        title: 'No HTTP Strict-Transport-Security header',
        detail:
          'Responses do not send Strict-Transport-Security, so a first request can be downgraded to HTTP.',
        recommendedFix:
          'Add Strict-Transport-Security with a max-age of at least 180 days once HTTPS is stable.',
        confidence: 0.7,
      }),
    );
  }
  if (!sec.contentTypeOptions) {
    out.push(
      draft({
        code: 'MISSING_X_CONTENT_TYPE_OPTIONS',
        category: 'security',
        severity: 'INFO',
        normalizedUrl: null,
        title: 'No X-Content-Type-Options: nosniff',
        detail: 'Responses allow MIME sniffing, a minor hardening gap.',
        recommendedFix: 'Send X-Content-Type-Options: nosniff.',
        confidence: 0.6,
      }),
    );
  }
  return out;
};

// --- Internationalization ------------------------------------

const rMissingLang: Rule = (ctx) =>
  successHtmlPages(ctx)
    .filter((p) => !p.lang)
    .slice(0, 200)
    .map((p) =>
      draft({
        code: 'MISSING_HTML_LANG',
        category: 'internationalization',
        severity: 'LOW',
        normalizedUrl: p.normalizedUrl,
        title: 'No lang attribute on <html>',
        detail: `${p.normalizedUrl} does not declare a language, which matters for assistive tech and language targeting.`,
        recommendedFix: 'Add <html lang="…"> with the correct BCP-47 code.',
        confidence: 0.8,
      }),
    );

const rHreflang: Rule = (ctx) => {
  const out: IssueDraft[] = [];
  const byUrl = new Map(ctx.pages.map((p) => [p.normalizedUrl, p]));
  for (const p of ctx.pages) {
    if (p.hreflang.length === 0) continue;
    // Invalid code
    const bad = p.hreflang.filter(
      (h) => !/^([a-z]{2,3})(-[a-z]{2,4})?(-[a-z]{4})?$|^x-default$/i.test(h.hreflang),
    );
    if (bad.length > 0) {
      out.push(
        draft({
          code: 'HREFLANG_INVALID',
          category: 'internationalization',
          severity: 'MEDIUM',
          normalizedUrl: p.normalizedUrl,
          title: 'Invalid hreflang value',
          detail: `${p.normalizedUrl} has hreflang value(s) that are not valid language/region codes: ${bad
            .map((b) => b.hreflang)
            .join(', ')}.`,
          recommendedFix: 'Use valid BCP-47 codes (e.g. "en", "en-GB", "x-default").',
          evidence: { bad },
          confidence: 0.85,
        }),
      );
    }
    // Missing return tag
    for (const h of p.hreflang) {
      let target: URL;
      try {
        target = new URL(h.href);
      } catch {
        continue;
      }
      const t = byUrl.get(target.toString());
      if (t && !t.hreflang.some((x) => sameHost(x.href, p.normalizedUrl))) {
        out.push(
          draft({
            code: 'HREFLANG_NO_RETURN_TAG',
            category: 'internationalization',
            severity: 'LOW',
            normalizedUrl: p.normalizedUrl,
            title: 'hreflang without a return tag',
            detail: `${p.normalizedUrl} links to ${h.href} via hreflang, but that page does not link back. hreflang annotations must be reciprocal.`,
            recommendedFix: 'Add the reciprocal hreflang annotation on every alternate page.',
            evidence: { to: h.href },
            confidence: 0.6,
          }),
        );
        break;
      }
    }
  }
  return out;
};

// --- Sitemap / robots consistency ----------------------------

const rSitemapIssues: Rule = (ctx) => {
  const out: IssueDraft[] = [];
  for (const s of ctx.sitemap.issues) {
    out.push(
      draft({
        code: `SITEMAP_${s.code}`,
        category: 'crawlability',
        severity: s.code === 'INVALID_XML' ? 'HIGH' : 'LOW',
        normalizedUrl: null,
        title: `Sitemap problem: ${s.code}`,
        detail: s.detail,
        recommendedFix: 'Fix the sitemap so crawlers can rely on it.',
        confidence: 0.9,
      }),
    );
  }
  if (ctx.sitemap.nonIndexableInSitemap.length > 0) {
    out.push(
      draft({
        code: 'SITEMAP_NONINDEXABLE_URL',
        category: 'indexability',
        severity: 'MEDIUM',
        normalizedUrl: null,
        title: 'Sitemap lists non-indexable URLs',
        detail: `${ctx.sitemap.nonIndexableInSitemap.length} URL(s) in the sitemap are noindex, blocked, redirected, or return an error. Sitemaps should list canonical, indexable URLs only.`,
        recommendedFix: 'Remove non-indexable URLs from the sitemap.',
        evidence: { urls: ctx.sitemap.nonIndexableInSitemap.slice(0, 25) },
        affectedUrlCount: ctx.sitemap.nonIndexableInSitemap.length,
        confidence: 0.8,
      }),
    );
  }
  if (ctx.sitemap.crawledNotInSitemap.length > 0 && ctx.sitemap.declaredCount > 0) {
    out.push(
      draft({
        code: 'SITEMAP_COVERAGE_GAP',
        category: 'architecture',
        severity: 'INFO',
        normalizedUrl: null,
        title: 'Indexable pages missing from the sitemap',
        detail: `${ctx.sitemap.crawledNotInSitemap.length} crawled indexable page(s) are not in any sitemap.`,
        recommendedFix: 'Add the missing URLs so crawlers discover them faster.',
        evidence: { urls: ctx.sitemap.crawledNotInSitemap.slice(0, 25) },
        affectedUrlCount: ctx.sitemap.crawledNotInSitemap.length,
        confidence: 0.6,
      }),
    );
  }
  if (ctx.robots.parsed && ctx.robots.parsed.issues.length > 0) {
    out.push(
      draft({
        code: 'ROBOTS_SYNTAX',
        category: 'crawlability',
        severity: 'LOW',
        normalizedUrl: null,
        title: 'robots.txt has syntax problems',
        detail: `${ctx.robots.parsed.issues.length} line(s) in robots.txt are malformed or use unknown directives.`,
        recommendedFix: 'Clean up robots.txt; unknown directives are ignored by crawlers.',
        evidence: { issues: ctx.robots.parsed.issues.slice(0, 20) },
        confidence: 0.8,
      }),
    );
  }
  if (ctx.robots.present && ctx.robots.parsed && ctx.robots.parsed.sitemaps.length === 0) {
    out.push(
      draft({
        code: 'ROBOTS_NO_SITEMAP_DIRECTIVE',
        category: 'crawlability',
        severity: 'INFO',
        normalizedUrl: null,
        title: 'robots.txt does not declare a sitemap',
        detail: 'Adding a Sitemap: line to robots.txt helps crawlers find your sitemap.',
        recommendedFix: 'Add "Sitemap: https://…/sitemap.xml" to robots.txt.',
        confidence: 0.7,
      }),
    );
  }
  return out;
};

const ALL_RULES: Rule[] = [
  rBlocked,
  rServerErrors,
  rBrokenInternal,
  rRedirectChain,
  rRedirectLoop,
  rFetchFailures,
  rNoindexOnLinked,
  rRobotsBlocksImportant,
  rCanonicalToNonCanonical,
  rParamIndexable,
  rDupTitle,
  rDupDesc,
  rDupContent,
  rDupUrlVariants,
  rOrphan,
  rNoInbound,
  rExcessiveDepth,
  rExcessiveUrlDepth,
  rMissingTitle,
  rTitleLength,
  rMissingDesc,
  rDescLength,
  rH1,
  rHeadingOrder,
  rImgAlt,
  rNoViewport,
  rNoLandmarks,
  rInvalidJsonLd,
  rNoStructuredData,
  rOgIncomplete,
  rSlow,
  rLargeHtml,
  rCsrOnly,
  rHttpsMissing,
  rMixedContent,
  rSecurityHeaders,
  rMissingLang,
  rHreflang,
  rSitemapIssues,
];

export function runRules(ctx: AuditContext): IssueDraft[] {
  const issues: IssueDraft[] = [];
  for (const rule of ALL_RULES) {
    try {
      issues.push(...rule(ctx));
    } catch {
      // A misbehaving rule must never fail the whole audit.
    }
  }
  // De-dupe on (code, normalizedUrl).
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.code}::${i.normalizedUrl ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isOrdered(headings: Array<{ level: number }>): boolean {
  let prev = 0;
  for (const h of headings) {
    if (prev !== 0 && h.level > prev + 1) return false;
    prev = h.level;
  }
  return true;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
