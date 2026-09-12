import {
  type SearchAnalyticsQuery,
  type SearchConsoleClient,
  ScAuthExpiredError,
  ScMalformedDataError,
  ScPermissionError,
  ScPropertyNotFoundError,
  ScQuotaExceededError,
  SearchConsoleApiError,
} from './client.js';
import type {
  SearchAnalyticsQueryResponse,
  SitemapResource,
  SitesListResponse,
  UrlInspectionResponse,
} from './schemas.js';

export type ScFixtureFault =
  | 'auth-expired-once'
  | 'quota-exceeded'
  | 'server-error'
  | 'permission-denied'
  | 'property-not-found'
  | 'malformed'
  | 'empty-analytics';

export interface ScFixtureConfig {
  sites: Array<{ siteUrl: string; permissionLevel: string }>;
  /** dimension key (joined by '|') → rows */
  analytics?: Record<
    string,
    Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>
  >;
  sitemaps?: SitemapResource[];
  inspection?: UrlInspectionResponse;
  faults?: Set<ScFixtureFault>;
}

/** Deterministic in-memory Search Console client for tests. */
export class FixturesSearchConsoleClient implements SearchConsoleClient {
  private authFailsRemaining = 0;
  constructor(private readonly cfg: ScFixtureConfig) {
    if (cfg.faults?.has('auth-expired-once')) this.authFailsRemaining = 1;
  }

  private guard(): void {
    if (this.cfg.faults?.has('server-error')) {
      throw new SearchConsoleApiError('Search Console API returned 503', 503, 'backendError');
    }
    if (this.cfg.faults?.has('quota-exceeded')) throw new ScQuotaExceededError('quotaExceeded');
    if (this.cfg.faults?.has('permission-denied')) throw new ScPermissionError();
    if (this.cfg.faults?.has('property-not-found')) throw new ScPropertyNotFoundError();
    if (this.authFailsRemaining > 0) {
      this.authFailsRemaining--;
      throw new ScAuthExpiredError();
    }
  }

  listSites(): Promise<SitesListResponse> {
    this.guard();
    if (this.cfg.faults?.has('malformed')) throw new ScMalformedDataError('sites.list', 'bad');
    return Promise.resolve({
      siteEntry: this.cfg.sites.map((s) => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
      })),
    });
  }

  getSite(siteUrl: string): Promise<{ siteUrl: string; permissionLevel?: string }> {
    this.guard();
    const s = this.cfg.sites.find((x) => x.siteUrl === siteUrl);
    if (!s) throw new ScPropertyNotFoundError(siteUrl);
    return Promise.resolve({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel });
  }

  querySearchAnalytics(query: SearchAnalyticsQuery): Promise<SearchAnalyticsQueryResponse> {
    this.guard();
    if (this.cfg.faults?.has('empty-analytics')) return Promise.resolve({ rows: [] });
    const key = query.dimensions.join('|');
    return Promise.resolve({ rows: this.cfg.analytics?.[key] ?? [] });
  }

  listSitemaps(): Promise<SitemapResource[]> {
    this.guard();
    return Promise.resolve(this.cfg.sitemaps ?? []);
  }

  inspectUrl(_siteUrl: string, inspectionUrl: string): Promise<UrlInspectionResponse> {
    this.guard();
    return Promise.resolve(
      this.cfg.inspection ?? {
        inspectionResult: {
          indexStatusResult: {
            verdict: 'PASS',
            coverageState: 'Submitted and indexed',
            lastCrawlTime: '2026-09-10T00:00:00Z',
            googleCanonical: inspectionUrl,
            userCanonical: inspectionUrl,
          },
        },
      },
    );
  }
}
