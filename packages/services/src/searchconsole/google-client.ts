import {
  type SearchAnalyticsQuery,
  type SearchConsoleClient,
  ScAuthExpiredError,
  ScMalformedDataError,
  ScPermissionError,
  ScPropertyNotFoundError,
  ScQuotaExceededError,
  SearchConsoleApiError,
  isQuotaReason,
  isRetryableStatus,
} from './client.js';
import {
  SearchAnalyticsQueryResponse,
  SitemapsListResponse,
  type SitemapResource,
  SiteResource,
  SitesListResponse,
  UrlInspectionResponse,
} from './schemas.js';

const WMX_BASE = 'https://www.googleapis.com/webmasters/v3';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const MAX_RETRIES = 3;

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Real Search Console client. Retries transient 5xx with jittered backoff; maps
 * 401 → `ScAuthExpiredError` (the caller refreshes and retries once), 403 quota
 * reasons → `ScQuotaExceededError`, other 403 → `ScPermissionError`, 404 →
 * `ScPropertyNotFoundError`. It does NOT refresh tokens itself —
 * `withFreshAccessToken` owns that.
 */
export class GoogleSearchConsoleClient implements SearchConsoleClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  private async request(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    siteUrl?: string,
  ): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        if (attempt <= MAX_RETRIES) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new SearchConsoleApiError(
          `Network error calling Search Console: ${e instanceof Error ? e.message : 'unknown'}`,
          0,
          'network',
        );
      }

      if (res.ok) {
        const text = await res.text();
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          throw new ScMalformedDataError(url, 'non-JSON body');
        }
      }

      if (isRetryableStatus(res.status) && attempt <= MAX_RETRIES) {
        await sleep(backoff(attempt));
        continue;
      }

      let bodyJson: GoogleErrorBody = {};
      try {
        bodyJson = (await res.json()) as GoogleErrorBody;
      } catch {
        /* keep empty */
      }
      const reason = bodyJson.error?.errors?.[0]?.reason ?? '';
      const message = bodyJson.error?.message ?? `Search Console API returned ${res.status}`;

      if (res.status === 401) throw new ScAuthExpiredError();
      if (res.status === 403) {
        if (isQuotaReason(reason)) throw new ScQuotaExceededError(reason);
        throw new ScPermissionError(siteUrl);
      }
      if (res.status === 404) throw new ScPropertyNotFoundError(siteUrl);
      throw new SearchConsoleApiError(message, res.status, reason || undefined);
    }
  }

  async listSites(): Promise<SitesListResponse> {
    const json = await this.request('GET', `${WMX_BASE}/sites`);
    const parsed = SitesListResponse.safeParse(json);
    if (!parsed.success) throw new ScMalformedDataError('sites.list', parsed.error.issues);
    return parsed.data;
  }

  async getSite(siteUrl: string): Promise<{ siteUrl: string; permissionLevel?: string }> {
    const json = await this.request(
      'GET',
      `${WMX_BASE}/sites/${encodeURIComponent(siteUrl)}`,
      undefined,
      siteUrl,
    );
    const parsed = SiteResource.safeParse(json);
    if (!parsed.success) throw new ScMalformedDataError('sites.get', parsed.error.issues);
    return parsed.data;
  }

  async querySearchAnalytics(query: SearchAnalyticsQuery): Promise<SearchAnalyticsQueryResponse> {
    const json = await this.request(
      'POST',
      `${WMX_BASE}/sites/${encodeURIComponent(query.siteUrl)}/searchAnalytics/query`,
      {
        startDate: query.startDate,
        endDate: query.endDate,
        dimensions: query.dimensions,
        rowLimit: query.rowLimit ?? 250,
        type: query.type ?? 'web',
        dataState: 'final',
      },
      query.siteUrl,
    );
    const parsed = SearchAnalyticsQueryResponse.safeParse(json);
    if (!parsed.success)
      throw new ScMalformedDataError('searchAnalytics.query', parsed.error.issues);
    return parsed.data;
  }

  async listSitemaps(siteUrl: string): Promise<SitemapResource[]> {
    const json = await this.request(
      'GET',
      `${WMX_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
      undefined,
      siteUrl,
    );
    const parsed = SitemapsListResponse.safeParse(json);
    if (!parsed.success) throw new ScMalformedDataError('sitemaps.list', parsed.error.issues);
    return parsed.data.sitemap;
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string): Promise<UrlInspectionResponse> {
    const json = await this.request(
      'POST',
      INSPECT_URL,
      { inspectionUrl, siteUrl, languageCode: 'en-US' },
      siteUrl,
    );
    const parsed = UrlInspectionResponse.safeParse(json);
    if (!parsed.success)
      throw new ScMalformedDataError('urlInspection.index.inspect', parsed.error.issues);
    return parsed.data;
  }
}

function backoff(attempt: number): number {
  return Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 150);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
