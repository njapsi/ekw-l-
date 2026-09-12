/**
 * Zod schemas for the Google Search Console API v1 responses and for the
 * `SearchConsoleSnapshot.data` shapes we persist. Raw API JSON is parsed
 * through these before it reaches the rest of the app — a shape mismatch is a
 * `ScMalformedDataError`, never silently trusted.
 *
 * References:
 *  - Search Console API v1 (sites, sitemaps, searchAnalytics): webmasters/v3
 *  - URL Inspection API: searchconsole.googleapis.com/v1/urlInspection
 */
import { z } from 'zod';

// --- sites.list -----------------------------------------------------------

export const SitesListResponse = z.object({
  siteEntry: z
    .array(
      z.object({
        siteUrl: z.string().min(1),
        permissionLevel: z.string().optional(),
      }),
    )
    .default([]),
});
export type SitesListResponse = z.infer<typeof SitesListResponse>;

export const SiteResource = z.object({
  siteUrl: z.string().min(1),
  permissionLevel: z.string().optional(),
});

// --- searchAnalytics.query --------------------------------------------

export const SearchAnalyticsRow = z.object({
  keys: z.array(z.string()).default([]),
  clicks: z.number().default(0),
  impressions: z.number().default(0),
  ctr: z.number().default(0),
  position: z.number().default(0),
});
export type SearchAnalyticsRow = z.infer<typeof SearchAnalyticsRow>;

export const SearchAnalyticsQueryResponse = z.object({
  rows: z.array(SearchAnalyticsRow).default([]),
  responseAggregationType: z.string().optional(),
});
export type SearchAnalyticsQueryResponse = z.infer<typeof SearchAnalyticsQueryResponse>;

// --- sitemaps.list / sitemaps.get -----------------------------------

export const SitemapResource = z.object({
  path: z.string().min(1),
  lastSubmitted: z.string().optional(),
  isPending: z.boolean().optional(),
  isSitemapsIndex: z.boolean().optional(),
  type: z.string().optional(),
  lastDownloaded: z.string().optional(),
  warnings: z.union([z.string(), z.number()]).optional(),
  errors: z.union([z.string(), z.number()]).optional(),
  contents: z
    .array(
      z.object({
        type: z.string().optional(),
        submitted: z.union([z.string(), z.number()]).optional(),
        indexed: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
});
export type SitemapResource = z.infer<typeof SitemapResource>;

export const SitemapsListResponse = z.object({
  sitemap: z.array(SitemapResource).default([]),
});
export type SitemapsListResponse = z.infer<typeof SitemapsListResponse>;

// --- urlInspection.index.inspect ----------------------------------

export const UrlInspectionResponse = z.object({
  inspectionResult: z
    .object({
      inspectionResultLink: z.string().optional(),
      indexStatusResult: z
        .object({
          verdict: z.string().optional(),
          coverageState: z.string().optional(),
          robotsTxtState: z.string().optional(),
          indexingState: z.string().optional(),
          lastCrawlTime: z.string().optional(),
          pageFetchState: z.string().optional(),
          googleCanonical: z.string().optional(),
          userCanonical: z.string().optional(),
          crawledAs: z.string().optional(),
          referringUrls: z.array(z.string()).optional(),
          sitemap: z.array(z.string()).optional(),
        })
        .optional(),
      mobileUsabilityResult: z.object({ verdict: z.string().optional() }).passthrough().optional(),
      richResultsResult: z.object({ verdict: z.string().optional() }).passthrough().optional(),
      ampResult: z.object({ verdict: z.string().optional() }).passthrough().optional(),
    })
    .optional(),
});
export type UrlInspectionResponse = z.infer<typeof UrlInspectionResponse>;

// --- persisted snapshot shapes -------------------------------------

export const PerfRow = z.object({
  keys: z.array(z.string()),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});
export type PerfRow = z.infer<typeof PerfRow>;

export const PerformanceSnapshotData = z.object({
  rangeDays: z.number(),
  totals: z.object({
    clicks: z.number(),
    impressions: z.number(),
    /** null when impressions === 0 — there is no CTR/position to average,
     * never a real measured 0 (Google positions start at 1). */
    ctr: z.number().nullable(),
    position: z.number().nullable(),
  }),
  byDate: z.array(PerfRow).default([]),
  byQuery: z.array(PerfRow).default([]),
  byPage: z.array(PerfRow).default([]),
  byCountry: z.array(PerfRow).default([]),
  byDevice: z.array(PerfRow).default([]),
  bySearchAppearance: z.array(PerfRow).default([]),
});
export type PerformanceSnapshotData = z.infer<typeof PerformanceSnapshotData>;

export const SitemapsSnapshotData = z.object({
  sitemaps: z.array(
    z.object({
      path: z.string(),
      lastSubmitted: z.string().nullable(),
      lastDownloaded: z.string().nullable(),
      isPending: z.boolean(),
      isSitemapsIndex: z.boolean(),
      type: z.string().nullable(),
      warnings: z.number(),
      errors: z.number(),
      contents: z.array(z.object({ type: z.string(), submitted: z.number(), indexed: z.number() })),
    }),
  ),
});
export type SitemapsSnapshotData = z.infer<typeof SitemapsSnapshotData>;

export const UrlInspectionSnapshotData = z.object({
  url: z.string(),
  verdict: z.string().nullable(),
  coverageState: z.string().nullable(),
  robotsTxtState: z.string().nullable(),
  indexingState: z.string().nullable(),
  lastCrawlTime: z.string().nullable(),
  pageFetchState: z.string().nullable(),
  googleCanonical: z.string().nullable(),
  userCanonical: z.string().nullable(),
  crawledAs: z.string().nullable(),
  referringUrls: z.array(z.string()),
  mobileUsabilityVerdict: z.string().nullable(),
  richResultsVerdict: z.string().nullable(),
});
export type UrlInspectionSnapshotData = z.infer<typeof UrlInspectionSnapshotData>;
