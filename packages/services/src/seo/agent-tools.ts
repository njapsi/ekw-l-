/**
 * Restricted, read-only tools for the AI SEO Agent (docs/SEO-ENGINE.md §6,
 * master instruction "AGENT TOOLS"). The agent reasons over **already-collected
 * crawler data** — it never crawls a site itself and it cannot modify a
 * production website: there is no write tool in this registry, by construction.
 *
 * Every tool is scoped by `organizationId` (from the tenant context, never from
 * tool input), takes a Zod-validated input, and returns plain data. The agent
 * calls these to build its evidence bundle; each call is logged on the
 * `AgentRun` for auditability.
 */
import type { Db } from '@growth-agent/db';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { NEAR_DUPLICATE_THRESHOLD, hammingDistance } from './fingerprint.js';
import { parseRobots } from './robots.js';
import type { CrawlScore } from './scoring.js';
import type { CrawlSummary } from './schemas.js';
import { urlPathDepth } from './url.js';

export interface SeoAgentToolContext {
  organizationId: string;
  db: Db;
}

export const SEO_AGENT_TOOL_NAMES = [
  'seo.get_project',
  'seo.get_crawl',
  'seo.get_page',
  'seo.get_issues',
  'seo.get_internal_links',
  'seo.get_sitemap',
  'seo.get_robots',
  'seo.get_schema',
  'seo.get_site_architecture',
] as const;
export type SeoAgentToolName = (typeof SEO_AGENT_TOOL_NAMES)[number];

interface SeoAgentTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: SeoAgentToolName;
  readonly description: string;
  readonly input: I;
  /** All SEO agent tools are read-only. There is no write tool. */
  readonly readOnly: true;
  execute(ctx: SeoAgentToolContext, input: z.infer<I>): Promise<unknown>;
}

// --- input schemas ----------------------------------------------------

const WebsiteRef = z.object({ websiteId: z.string() });

const CrawlRef = z
  .object({ crawlId: z.string().optional(), websiteId: z.string().optional() })
  .refine((v) => Boolean(v.crawlId || v.websiteId), 'crawlId or websiteId is required');

const PageRef = z
  .object({
    crawlId: z.string().optional(),
    websiteId: z.string().optional(),
    normalizedUrl: z.string().optional(),
    pageId: z.string().optional(),
    filter: z.enum(['all', 'problems', 'non_indexable']).default('all'),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .refine((v) => Boolean(v.crawlId || v.websiteId), 'crawlId or websiteId is required');

const IssuesRef = z
  .object({
    crawlId: z.string().optional(),
    websiteId: z.string().optional(),
    category: z.string().optional(),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
    code: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .refine((v) => Boolean(v.crawlId || v.websiteId), 'crawlId or websiteId is required');

const LinksRef = z
  .object({
    crawlId: z.string().optional(),
    websiteId: z.string().optional(),
    normalizedUrl: z.string().optional(),
    view: z.enum(['page', 'thin_pages', 'top_linked']).default('page'),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .refine((v) => Boolean(v.crawlId || v.websiteId), 'crawlId or websiteId is required');

// --- shared helpers -------------------------------------------------

async function resolveCrawl(
  ctx: SeoAgentToolContext,
  ref: { crawlId?: string; websiteId?: string },
) {
  if (ref.crawlId) {
    const crawl = await ctx.db.crawl.findFirst({
      where: { id: ref.crawlId, organizationId: ctx.organizationId },
      include: { website: true },
    });
    if (!crawl) throw AppError.notFound('Crawl');
    return crawl;
  }
  const crawl = await ctx.db.crawl.findFirst({
    where: { websiteId: ref.websiteId, organizationId: ctx.organizationId, status: 'COMPLETED' },
    orderBy: { finishedAt: 'desc' },
    include: { website: true },
  });
  if (!crawl) throw AppError.notFound('Completed crawl for website');
  return crawl;
}

function scoresOf(crawl: { scores: unknown }): CrawlScore | null {
  return (crawl.scores as CrawlScore | null) ?? null;
}
function summaryOf(crawl: { summary: unknown }): (CrawlSummary & Record<string, unknown>) | null {
  return (crawl.summary as (CrawlSummary & Record<string, unknown>) | null) ?? null;
}

// --- the tools ------------------------------------------------------

const getProject: SeoAgentTool<typeof WebsiteRef> = {
  name: 'seo.get_project',
  description:
    'The registered website ("project"): URL, verified status, and a one-line summary of its recent crawls.',
  input: WebsiteRef,
  readOnly: true,
  async execute(ctx, input) {
    const site = await ctx.db.website.findFirst({
      where: { id: input.websiteId, organizationId: ctx.organizationId },
      include: {
        crawls: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            status: true,
            createdAt: true,
            finishedAt: true,
            pagesCrawled: true,
            issuesFound: true,
            scores: true,
          },
        },
      },
    });
    if (!site) throw AppError.notFound('Website');
    return {
      websiteId: site.id,
      url: site.url,
      hostname: site.hostname,
      verified: site.verified,
      verificationMethod: site.verificationMethod,
      robotsFetchedAt: site.robotsFetchedAt,
      crawls: site.crawls.map((c) => ({
        crawlId: c.id,
        status: c.status,
        createdAt: c.createdAt,
        finishedAt: c.finishedAt,
        pagesCrawled: c.pagesCrawled,
        issuesFound: c.issuesFound,
        overallScore: (c.scores as CrawlScore | null)?.overall ?? null,
      })),
    };
  },
};

const getCrawl: SeoAgentTool<typeof CrawlRef> = {
  name: 'seo.get_crawl',
  description:
    'One crawl run: status, resolved config, category + overall scores, and the crawl summary aggregates.',
  input: CrawlRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);
    return {
      crawlId: crawl.id,
      websiteId: crawl.websiteId,
      hostname: crawl.website.hostname,
      status: crawl.status,
      renderMode: crawl.renderMode,
      blockedReason: crawl.blockedReason,
      startedAt: crawl.startedAt,
      finishedAt: crawl.finishedAt,
      pagesCrawled: crawl.pagesCrawled,
      issuesFound: crawl.issuesFound,
      config: crawl.config,
      scores: scoresOf(crawl),
      summary: summaryOf(crawl),
    };
  },
};

const getPage: SeoAgentTool<typeof PageRef> = {
  name: 'seo.get_page',
  description:
    'A single analyzed page by normalizedUrl / pageId, or a filtered page list for the crawl (filter: all | problems | non_indexable).',
  input: PageRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);
    if (input.normalizedUrl || input.pageId) {
      const page = await ctx.db.crawlPage.findFirst({
        where: {
          crawlId: crawl.id,
          ...(input.pageId ? { id: input.pageId } : { normalizedUrl: input.normalizedUrl }),
        },
      });
      if (!page) throw AppError.notFound('Crawl page');
      return page;
    }
    const where =
      input.filter === 'problems'
        ? {
            crawlId: crawl.id,
            OR: [{ httpStatus: { gte: 400 } }, { indexable: false }, { fetchError: { not: null } }],
          }
        : input.filter === 'non_indexable'
          ? { crawlId: crawl.id, indexable: false }
          : { crawlId: crawl.id };
    const rows = await ctx.db.crawlPage.findMany({
      where,
      orderBy: [{ depth: 'asc' }, { normalizedUrl: 'asc' }],
      take: input.limit,
      select: {
        id: true,
        normalizedUrl: true,
        depth: true,
        discoveredVia: true,
        httpStatus: true,
        indexable: true,
        indexabilityReason: true,
        noindex: true,
        robotsBlocked: true,
        canonicalUrl: true,
        canonicalIsSelf: true,
        title: true,
        titleLength: true,
        metaDescription: true,
        h1Count: true,
        wordCount: true,
        jsonLdTypes: true,
        landmarkCount: true,
        hasMainLandmark: true,
        internalLinkCount: true,
        inboundInternalCount: true,
        responseTimeMs: true,
        renderedWithJs: true,
        csrLikely: true,
        fetchError: true,
      },
    });
    return { crawlId: crawl.id, count: rows.length, pages: rows };
  },
};

const getIssues: SeoAgentTool<typeof IssuesRef> = {
  name: 'seo.get_issues',
  description:
    'Technical-auditor issues for the crawl, optionally filtered by category / severity / code. Each has evidence, a recommended fix, an affected-URL count and a confidence.',
  input: IssuesRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);
    const rows = await ctx.db.crawlIssue.findMany({
      where: {
        crawlId: crawl.id,
        ...(input.category ? { category: input.category } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.code ? { code: input.code } : {}),
      },
      orderBy: [{ severity: 'asc' }, { affectedUrlCount: 'desc' }],
      take: input.limit,
      select: {
        id: true,
        code: true,
        category: true,
        severity: true,
        normalizedUrl: true,
        title: true,
        detail: true,
        evidence: true,
        recommendedFix: true,
        confidence: true,
        affectedUrlCount: true,
        status: true,
      },
    });
    return { crawlId: crawl.id, count: rows.length, issues: rows };
  },
};

const getInternalLinks: SeoAgentTool<typeof LinksRef> = {
  name: 'seo.get_internal_links',
  description:
    'The internal link graph: inbound + outbound edges for a page (view=page), or crawl-wide views of thinly-linked pages (view=thin_pages) and the most-linked pages (view=top_linked).',
  input: LinksRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);

    if (input.view === 'page') {
      if (!input.normalizedUrl)
        throw AppError.validation('normalizedUrl is required for view=page');
      const page = await ctx.db.crawlPage.findFirst({
        where: { crawlId: crawl.id, normalizedUrl: input.normalizedUrl },
        select: { id: true, inboundInternalCount: true, internalLinkCount: true },
      });
      if (!page) throw AppError.notFound('Crawl page');
      const [outbound, inbound] = await Promise.all([
        ctx.db.crawlLink.findMany({
          where: { crawlId: crawl.id, fromPageId: page.id, isInternal: true },
          take: input.limit,
          select: { toNormalizedUrl: true, anchorText: true, isNofollow: true },
        }),
        ctx.db.crawlLink.findMany({
          where: { crawlId: crawl.id, toNormalizedUrl: input.normalizedUrl, isInternal: true },
          take: input.limit,
          select: { anchorText: true, isNofollow: true },
        }),
      ]);
      return {
        normalizedUrl: input.normalizedUrl,
        inboundCount: page.inboundInternalCount,
        outboundCount: page.internalLinkCount,
        outbound,
        inboundAnchors: inbound.map((i) => i.anchorText).filter(Boolean),
      };
    }

    if (input.view === 'top_linked') {
      const rows = await ctx.db.crawlPage.findMany({
        where: { crawlId: crawl.id },
        orderBy: { inboundInternalCount: 'desc' },
        take: input.limit,
        select: { normalizedUrl: true, inboundInternalCount: true, depth: true },
      });
      return { view: 'top_linked', pages: rows };
    }

    const rows = await ctx.db.crawlPage.findMany({
      where: { crawlId: crawl.id, indexable: true, inboundInternalCount: { lte: 1 } },
      orderBy: { inboundInternalCount: 'asc' },
      take: input.limit,
      select: { normalizedUrl: true, inboundInternalCount: true, depth: true },
    });
    return { view: 'thin_pages', pages: rows };
  },
};

const getSitemap: SeoAgentTool<typeof CrawlRef> = {
  name: 'seo.get_sitemap',
  description:
    'Sitemap analysis from the crawl: declared sitemaps, URL count, parse issues, and coverage cross-checks (in-sitemap-not-crawled, crawled-not-in-sitemap, non-indexable-in-sitemap).',
  input: CrawlRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);
    const s = summaryOf(crawl);
    const relatedIssues = await ctx.db.crawlIssue.findMany({
      where: { crawlId: crawl.id, code: { startsWith: 'SITEMAP_' } },
      select: { code: true, severity: true, title: true, detail: true, affectedUrlCount: true },
    });
    return { crawlId: crawl.id, sitemap: s?.sitemap ?? null, relatedIssues };
  },
};

const getRobots: SeoAgentTool<typeof CrawlRef> = {
  name: 'seo.get_robots',
  description:
    "The site's robots.txt as cached at crawl time: user-agent groups, Allow/Disallow rules, Crawl-delay, declared sitemaps, syntax problems, whether it fully disallows our crawler, and how many sitemap paths it blocks.",
  input: CrawlRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);
    const site = await ctx.db.website.findUnique({
      where: { id: crawl.websiteId },
      select: { robotsTxtCache: true, robotsFetchedAt: true },
    });
    const s = summaryOf(crawl);
    const parsed = site?.robotsTxtCache ? parseRobots(site.robotsTxtCache) : null;
    return {
      crawlId: crawl.id,
      present: Boolean(site?.robotsTxtCache),
      fetchedAt: site?.robotsFetchedAt ?? null,
      fullyDisallowed: s?.robots?.fullyDisallowed ?? false,
      syntaxIssues: parsed?.issues ?? [],
      declaredSitemaps: parsed?.sitemaps ?? [],
      groups:
        parsed?.groups.map((g) => ({
          userAgents: g.userAgents,
          crawlDelaySec: g.crawlDelaySec,
          rules: g.rules.slice(0, 100),
        })) ?? [],
      importantPathsBlocked: s?.robots?.importantPathsBlocked ?? 0,
    };
  },
};

const getSchema: SeoAgentTool<typeof CrawlRef> = {
  name: 'seo.get_schema',
  description:
    'Structured-data (JSON-LD) picture across the crawl: type histogram, pages with parse errors, share of indexable pages with no structured data, and an entity-consistency check on any declared Organization / WebSite name.',
  input: CrawlRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);
    const pages = await ctx.db.crawlPage.findMany({
      where: { crawlId: crawl.id },
      select: {
        normalizedUrl: true,
        indexable: true,
        jsonLdTypes: true,
        jsonLdErrors: true,
        jsonLdEntities: true,
      },
    });
    const typeHistogram: Record<string, number> = {};
    const pagesWithErrors: string[] = [];
    let indexable = 0;
    let indexableWithoutSchema = 0;
    const orgNames = new Map<string, number>();
    for (const p of pages) {
      for (const t of p.jsonLdTypes) typeHistogram[t] = (typeHistogram[t] ?? 0) + 1;
      const errs = p.jsonLdErrors as unknown[];
      if (Array.isArray(errs) && errs.length > 0) pagesWithErrors.push(p.normalizedUrl);
      if (p.indexable) {
        indexable++;
        if (p.jsonLdTypes.length === 0) indexableWithoutSchema++;
      }
      const ents = (p.jsonLdEntities as Array<{ type: string; name: string | null }>) ?? [];
      for (const e of ents) {
        if ((e.type === 'Organization' || e.type === 'WebSite') && e.name) {
          orgNames.set(e.name, (orgNames.get(e.name) ?? 0) + 1);
        }
      }
    }
    return {
      crawlId: crawl.id,
      typeHistogram,
      pagesWithParseErrors: pagesWithErrors.slice(0, 50),
      pagesWithParseErrorCount: pagesWithErrors.length,
      indexablePages: indexable,
      indexablePagesWithoutStructuredData: indexableWithoutSchema,
      organizationEntityNames: [...orgNames.entries()].map(([name, count]) => ({ name, count })),
      entityNameConsistent: orgNames.size <= 1,
    };
  },
};

const getSiteArchitecture: SeoAgentTool<typeof CrawlRef> = {
  name: 'seo.get_site_architecture',
  description:
    'Site-architecture aggregates: crawl-depth histogram, orphan / non-indexable counts, redirect chains + loops, duplicate title / content clusters, and the deepest URLs.',
  input: CrawlRef,
  readOnly: true,
  async execute(ctx, input) {
    const crawl = await resolveCrawl(ctx, input);
    const s = summaryOf(crawl);
    const deepest = await ctx.db.crawlPage.findMany({
      where: { crawlId: crawl.id },
      orderBy: { depth: 'desc' },
      take: 15,
      select: { normalizedUrl: true, depth: true },
    });
    const hashed = await ctx.db.crawlPage.findMany({
      where: { crawlId: crawl.id, simhash: { not: null }, wordCount: { gt: 40 } },
      select: { normalizedUrl: true, simhash: true },
      take: 2000,
    });
    const clusters: Array<{ anchor: string; urls: string[] }> = [];
    for (const p of hashed) {
      const hit = clusters.find(
        (c) => hammingDistance(c.anchor, p.simhash as string) <= NEAR_DUPLICATE_THRESHOLD,
      );
      if (hit) hit.urls.push(p.normalizedUrl);
      else clusters.push({ anchor: p.simhash as string, urls: [p.normalizedUrl] });
    }
    return {
      crawlId: crawl.id,
      byDepth: s?.byDepth ?? {},
      indexablePages: s?.indexablePages ?? 0,
      nonIndexablePages: s?.nonIndexablePages ?? 0,
      orphanPages: s?.orphanPages ?? 0,
      redirectChains: s?.redirectChains ?? 0,
      redirectLoops: s?.redirectLoops ?? 0,
      duplicateTitleGroups: s?.duplicateTitleGroups ?? 0,
      duplicateContentClusters: clusters.filter((c) => c.urls.length > 1).length,
      deepestUrls: deepest,
      averageUrlPathDepth:
        hashed.length > 0
          ? Number(
              (
                hashed.reduce((sum, p) => sum + urlPathDepth(p.normalizedUrl), 0) / hashed.length
              ).toFixed(2),
            )
          : null,
    };
  },
};

export const SEO_AGENT_TOOLS: readonly SeoAgentTool[] = [
  getProject,
  getCrawl,
  getPage,
  getIssues,
  getInternalLinks,
  getSitemap,
  getRobots,
  getSchema,
  getSiteArchitecture,
];

const TOOL_BY_NAME = new Map<string, SeoAgentTool>(SEO_AGENT_TOOLS.map((t) => [t.name, t]));

export function isSeoAgentToolName(name: string): name is SeoAgentToolName {
  return (SEO_AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

export interface SeoToolCallRecord {
  /** A `seo.*` (crawler) or `gsc.*` (Search Console) tool name. */
  tool: string;
  input: unknown;
  ok: boolean;
  error?: string;
}

/**
 * Execute one restricted tool. Rejects any name not in the allowlist and
 * validates the input against the tool's schema. This is the ONLY entrypoint
 * the agent uses to touch crawl data.
 */
export async function executeSeoTool(
  name: string,
  rawInput: unknown,
  ctx: SeoAgentToolContext,
): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool || !isSeoAgentToolName(name)) {
    throw AppError.validation(`"${name}" is not an allowed SEO agent tool.`);
  }
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return tool.execute(ctx, parsed.data);
}

export function describeSeoAgentTools(): Array<{
  name: string;
  description: string;
  readOnly: true;
}> {
  return SEO_AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, readOnly: true }));
}

/** Bind the tool context once so the agent can call `tools.get_issues(...)`. */
export function bindSeoAgentTools(ctx: SeoAgentToolContext) {
  const call =
    (name: SeoAgentToolName) =>
    (input: Record<string, unknown> = {}) =>
      executeSeoTool(name, input, ctx);
  return {
    get_project: call('seo.get_project'),
    get_crawl: call('seo.get_crawl'),
    get_page: call('seo.get_page'),
    get_issues: call('seo.get_issues'),
    get_internal_links: call('seo.get_internal_links'),
    get_sitemap: call('seo.get_sitemap'),
    get_robots: call('seo.get_robots'),
    get_schema: call('seo.get_schema'),
    get_site_architecture: call('seo.get_site_architecture'),
  };
}

export type BoundSeoAgentTools = ReturnType<typeof bindSeoAgentTools>;
