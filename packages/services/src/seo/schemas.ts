/**
 * Zod schemas + shared unions for the SEO engine. `CrawlConfig` is the resolved
 * plan persisted on `Crawl.config`.
 */
import { z } from 'zod';

export const RENDER_MODES = ['STATIC', 'AUTO', 'HEADLESS'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export const ISSUE_CATEGORIES = [
  'crawlability',
  'indexability',
  'architecture',
  'internal_linking',
  'metadata',
  'structured_data',
  'performance',
  'security',
  'internationalization',
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const ISSUE_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** Tier ceilings (docs/SEO-ENGINE.md "Limits & fairness"). */
export const CRAWL_LIMITS = {
  maxPagesCeiling: 200_000,
  maxDepthCeiling: 20,
  maxDurationSecCeiling: 6 * 60 * 60,
  concurrencyCeiling: 8,
  minCrawlDelayMs: 250,
  maxResponseBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
  renderBudgetMs: 15_000,
  brokenLinkCheckCap: 500,
  /** Unverified sites: shallow public sample only. */
  unverifiedMaxPages: 10,
  unverifiedMaxDepth: 1,
} as const;

export const CrawlConfig = z.object({
  seedUrl: z.string().url(),
  hostname: z.string(),
  registrableDomain: z.string(),
  additionalHosts: z.array(z.string()).default([]),
  includePaths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
  maxPages: z.number().int().positive().max(CRAWL_LIMITS.maxPagesCeiling),
  maxDepth: z.number().int().min(0).max(CRAWL_LIMITS.maxDepthCeiling),
  maxDurationSec: z.number().int().positive().max(CRAWL_LIMITS.maxDurationSecCeiling),
  concurrency: z.number().int().min(1).max(CRAWL_LIMITS.concurrencyCeiling),
  crawlDelayMs: z.number().int().min(0),
  renderMode: z.enum(RENDER_MODES).default('STATIC'),
  respectRobots: z.boolean().default(true),
  /** True ⇒ ownership not verified, so a shallow public sample only. */
  publicSampleOnly: z.boolean().default(false),
  maxResponseBytes: z.number().int().positive().default(CRAWL_LIMITS.maxResponseBytes),
  userAgent: z.string().default(''),
});
export type CrawlConfig = z.infer<typeof CrawlConfig>;

/** What the UI sends when starting a crawl; the planner resolves it against
 * tier ceilings + the ownership gate. */
export const CrawlRequest = z.object({
  maxPages: z.number().int().positive().optional(),
  maxDepth: z.number().int().min(0).optional(),
  maxDurationSec: z.number().int().positive().optional(),
  concurrency: z.number().int().min(1).optional(),
  crawlDelayMs: z.number().int().min(0).optional(),
  renderMode: z.enum(RENDER_MODES).optional(),
  respectRobots: z.boolean().optional(),
  includePaths: z.array(z.string().max(400)).max(50).optional(),
  excludePaths: z.array(z.string().max(400)).max(50).optional(),
});
export type CrawlRequest = z.infer<typeof CrawlRequest>;

export const CrawlSummary = z.object({
  totalPages: z.number(),
  byStatusClass: z.record(z.string(), z.number()),
  byDepth: z.record(z.string(), z.number()),
  indexablePages: z.number(),
  nonIndexablePages: z.number(),
  orphanPages: z.number(),
  brokenInternalLinks: z.number(),
  redirectChains: z.number(),
  redirectLoops: z.number(),
  duplicateTitleGroups: z.number(),
  duplicateContentClusters: z.number(),
  sitemap: z.object({
    declared: z.number(),
    urls: z.number(),
    inSitemapNotCrawled: z.number(),
    crawledNotInSitemap: z.number(),
    nonIndexableInSitemap: z.number(),
  }),
  robots: z.object({
    present: z.boolean(),
    fullyDisallowed: z.boolean(),
    syntaxIssues: z.number(),
    importantPathsBlocked: z.number(),
  }),
  renderedPages: z.number(),
  averageResponseMs: z.number().nullable(),
  crawlDurationSec: z.number(),
  reachedPageCap: z.boolean(),
  reachedTimeCap: z.boolean(),
  blocked: z.boolean(),
});
export type CrawlSummary = z.infer<typeof CrawlSummary>;
