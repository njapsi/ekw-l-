/**
 * Crawl planning (docs/SEO-ENGINE.md §1 "Plan" + "Discovery inputs"). Turns a
 * verified `Website` + a `CrawlRequest` into a resolved `CrawlPlan`:
 *   - validate URL + hostname + SSRF (no private/internal targets)
 *   - establish crawl boundaries (registrable domain, path filters)
 *   - resolve limits against tier ceilings AND the ownership gate
 *   - fetch + parse robots.txt (respect `Crawl-delay`, collect `Sitemap:`)
 *   - discover + parse sitemaps (one level of sitemap-index nesting, capped)
 */
import { createLogger } from '@growth-agent/observability';
import { AppError } from '../errors.js';
import { type FetchPageOptions, fetchPage } from './fetch.js';
import { DEFAULT_USER_AGENT } from './fetch.js';
import { type ParsedRobots, isFullyDisallowed, parseRobots } from './robots.js';
import { CRAWL_LIMITS, CrawlConfig, CrawlRequest } from './schemas.js';
import { parseSitemap } from './sitemap.js';
import { assertSafeUrl } from './ssrf.js';
import { normalizeUrl, parseUrl, registrableDomain } from './url.js';

const log = createLogger('seo.plan');

const SITEMAP_INDEX_CHILD_CAP = 20;
const SITEMAP_URL_CAP = 5000;

export interface PlanInputWebsite {
  id: string;
  url: string;
  hostname: string;
  verified: boolean;
}

export interface CrawlPlan {
  config: CrawlConfig;
  seeds: string[];
  robots: {
    present: boolean;
    body: string | null;
    parsed: ParsedRobots | null;
    fullyDisallowed: boolean;
    crawlDelayMs: number;
  };
  sitemap: {
    declaredUrls: string[];
    urls: string[];
    issues: Array<{ code: string; detail: string }>;
  };
  /** True ⇒ robots.txt blocks everything; the crawl should record BLOCKED. */
  blocked: boolean;
  notes: string[];
}

export interface PlanOptions {
  fetchOptions?: FetchPageOptions;
  /** Override the resolved user agent. */
  userAgent?: string;
}

export async function planCrawl(
  website: PlanInputWebsite,
  request: CrawlRequest,
  opts: PlanOptions = {},
): Promise<CrawlPlan> {
  const req = CrawlRequest.parse(request);
  const notes: string[] = [];
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  // 1–3. URL + hostname + SSRF validation.
  let seed: URL;
  try {
    seed = parseUrl(website.url);
  } catch (e) {
    throw AppError.validation(
      `Website URL is invalid: ${e instanceof Error ? e.message : 'bad URL'}`,
    );
  }
  try {
    await assertSafeUrl(seed.toString(), { lookup: opts.fetchOptions?.lookup });
  } catch (e) {
    throw AppError.validation(
      `Refusing to crawl "${website.url}": ${e instanceof Error ? e.message : 'blocked target'}`,
    );
  }

  const host = seed.hostname.toLowerCase();
  const regDomain = registrableDomain(host);

  // 4. Boundaries + limits.
  const ownershipGate = !website.verified;
  if (ownershipGate) {
    notes.push(
      'Website ownership is not verified — this crawl is limited to a shallow public sample (≤ 10 pages, depth ≤ 1, no rendering).',
    );
  }

  const maxPages = clamp(
    req.maxPages ?? 500,
    1,
    ownershipGate ? CRAWL_LIMITS.unverifiedMaxPages : CRAWL_LIMITS.maxPagesCeiling,
  );
  const maxDepth = clamp(
    req.maxDepth ?? 5,
    0,
    ownershipGate ? CRAWL_LIMITS.unverifiedMaxDepth : CRAWL_LIMITS.maxDepthCeiling,
  );
  const maxDurationSec = clamp(req.maxDurationSec ?? 600, 30, CRAWL_LIMITS.maxDurationSecCeiling);
  const concurrency = clamp(req.concurrency ?? 3, 1, CRAWL_LIMITS.concurrencyCeiling);
  const renderMode = ownershipGate ? 'STATIC' : (req.renderMode ?? 'STATIC');
  const respectRobots = req.respectRobots ?? true;
  if (!respectRobots && ownershipGate) {
    throw AppError.validation('robots.txt can only be overridden for a verified website you own.');
  }

  // 5. robots.txt
  const robotsUrl = `${seed.origin}/robots.txt`;
  let robotsBody: string | null = null;
  let parsedRobots: ParsedRobots | null = null;
  let crawlDelayMs: number = CRAWL_LIMITS.minCrawlDelayMs;
  try {
    const res = await fetchPage(robotsUrl, {
      ...opts.fetchOptions,
      maxBytes: 512 * 1024,
      userAgent,
    });
    if (res.ok && res.status === 200 && res.body) {
      robotsBody = res.body.slice(0, 512 * 1024);
      parsedRobots = parseRobots(robotsBody);
      const group = parsedRobots.groups.find((g) =>
        g.userAgents.some((u) => u === '*' || userAgent.toLowerCase().includes(u)),
      );
      if (group?.crawlDelaySec != null) {
        crawlDelayMs = Math.max(crawlDelayMs, Math.round(group.crawlDelaySec * 1000));
      }
    } else if (res.ok && res.status === 404) {
      notes.push('No robots.txt (HTTP 404) — treating the whole site as crawlable.');
    } else if (!res.ok) {
      notes.push(`Could not fetch robots.txt (${res.reason}); assuming crawlable.`);
    }
  } catch (e) {
    log.warn({ robotsUrl, err: String(e) }, 'robots.txt fetch threw');
    notes.push('robots.txt fetch failed; assuming crawlable.');
  }

  const requestedCrawlDelay = req.crawlDelayMs ?? crawlDelayMs;
  crawlDelayMs = Math.max(CRAWL_LIMITS.minCrawlDelayMs, requestedCrawlDelay, crawlDelayMs);

  const fullyDisallowed = Boolean(
    respectRobots && parsedRobots && isFullyDisallowed(parsedRobots, userAgent),
  );

  // 6–7. Sitemaps.
  const declaredSitemaps = new Set<string>([
    `${seed.origin}/sitemap.xml`,
    ...(parsedRobots?.sitemaps ?? []),
  ]);
  const sitemapIssues: Array<{ code: string; detail: string }> = [];
  const sitemapUrls = new Set<string>();
  let childCount = 0;

  for (const sm of declaredSitemaps) {
    if (sitemapUrls.size >= SITEMAP_URL_CAP) break;
    let safeSm: string;
    try {
      const parsed = await assertSafeUrl(sm, { lookup: opts.fetchOptions?.lookup });
      safeSm = parsed.url.toString();
    } catch {
      sitemapIssues.push({ code: 'BAD_LOC', detail: `Skipped unsafe sitemap URL ${sm}` });
      continue;
    }
    if (registrableDomain(new URL(safeSm).hostname) !== regDomain) continue;

    const res = await fetchPage(safeSm, {
      ...opts.fetchOptions,
      maxBytes: 20 * 1024 * 1024,
      userAgent,
    });
    if (!res.ok || res.status !== 200 || !res.body) {
      if (sm !== `${seed.origin}/sitemap.xml`) {
        sitemapIssues.push({
          code: 'BAD_LOC',
          detail: `Declared sitemap ${sm} returned ${res.ok ? `HTTP ${res.status}` : res.reason}.`,
        });
      }
      continue;
    }
    const parsed = parseSitemap(res.body);
    for (const iss of parsed.issues) sitemapIssues.push({ code: iss.code, detail: iss.detail });

    if (parsed.kind === 'sitemapindex') {
      for (const child of parsed.entries) {
        if (childCount >= SITEMAP_INDEX_CHILD_CAP) break;
        childCount++;
        try {
          const cs = await assertSafeUrl(child.loc, { lookup: opts.fetchOptions?.lookup });
          if (registrableDomain(cs.url.hostname) !== regDomain) continue;
          const cres = await fetchPage(cs.url.toString(), {
            ...opts.fetchOptions,
            maxBytes: 20 * 1024 * 1024,
            userAgent,
          });
          if (cres.ok && cres.status === 200 && cres.body) {
            const cparsed = parseSitemap(cres.body);
            for (const iss of cparsed.issues)
              sitemapIssues.push({ code: iss.code, detail: iss.detail });
            for (const e of cparsed.entries) addSitemapUrl(sitemapUrls, e.loc, regDomain);
          }
        } catch {
          sitemapIssues.push({ code: 'BAD_LOC', detail: `Unsafe child sitemap ${child.loc}` });
        }
      }
    } else if (parsed.kind === 'urlset') {
      for (const e of parsed.entries) addSitemapUrl(sitemapUrls, e.loc, regDomain);
    }
  }

  const config = CrawlConfig.parse({
    seedUrl: seed.toString(),
    hostname: host,
    registrableDomain: regDomain,
    additionalHosts: hostVariants(host),
    includePaths: req.includePaths ?? [],
    excludePaths: req.excludePaths ?? [],
    maxPages,
    maxDepth,
    maxDurationSec,
    concurrency,
    crawlDelayMs,
    renderMode,
    respectRobots,
    publicSampleOnly: ownershipGate,
    maxResponseBytes: CRAWL_LIMITS.maxResponseBytes,
    userAgent,
  });

  // 8–9. Seeds: the start URL plus a slice of sitemap URLs (still scope-gated).
  const seeds = [normalizeUrl(seed.toString())];
  const sitemapList = [...sitemapUrls];

  return {
    config,
    seeds,
    robots: {
      present: robotsBody != null,
      body: robotsBody,
      parsed: parsedRobots,
      fullyDisallowed,
      crawlDelayMs,
    },
    sitemap: {
      declaredUrls: [...declaredSitemaps],
      urls: sitemapList,
      issues: sitemapIssues,
    },
    blocked: fullyDisallowed,
    notes,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function hostVariants(host: string): string[] {
  return host.startsWith('www.') ? [host.slice(4)] : [`www.${host}`];
}

function addSitemapUrl(into: Set<string>, loc: string, regDomain: string): void {
  if (into.size >= SITEMAP_URL_CAP) return;
  try {
    const n = normalizeUrl(loc);
    if (registrableDomain(new URL(n).hostname) === regDomain) into.add(n);
  } catch {
    /* skip malformed loc */
  }
}
