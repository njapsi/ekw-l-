/**
 * Provider-agnostic Search Console client. `google-client.ts` is the real
 * implementation; `fixtures-client.ts` is used by tests. Every method maps the
 * official API's failure modes onto typed errors so the resilient wrapper and
 * the UI can react precisely (refresh a token, surface a permission problem,
 * back off on quota).
 */
import type {
  SearchAnalyticsQueryResponse,
  SitemapResource,
  SitesListResponse,
  UrlInspectionResponse,
} from './schemas.js';

export type SearchAnalyticsDimension =
  'date' | 'query' | 'page' | 'country' | 'device' | 'searchAppearance';

export interface SearchAnalyticsQuery {
  siteUrl: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  dimensions: SearchAnalyticsDimension[];
  rowLimit?: number;
  type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
}

export interface SearchConsoleClient {
  /** sites.list — every property the token owner can access. */
  listSites(): Promise<SitesListResponse>;
  /** sites.get — the caller's permission level on one property. */
  getSite(siteUrl: string): Promise<{ siteUrl: string; permissionLevel?: string }>;
  /** searchanalytics.query — one call per dimension set. */
  querySearchAnalytics(query: SearchAnalyticsQuery): Promise<SearchAnalyticsQueryResponse>;
  /** sitemaps.list — submitted sitemaps + their submitted/indexed counts. */
  listSitemaps(siteUrl: string): Promise<SitemapResource[]>;
  /** urlInspection.index.inspect — indexing status for ONE url (quota-scarce). */
  inspectUrl(siteUrl: string, inspectionUrl: string): Promise<UrlInspectionResponse>;
}

// --- typed errors ------------------------------------------------------

export class SearchConsoleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'SearchConsoleApiError';
  }
}

/** 401 — the access token is invalid/expired; the caller should refresh + retry once. */
export class ScAuthExpiredError extends SearchConsoleApiError {
  constructor() {
    super('Search Console rejected the access token (401).', 401, 'authError');
    this.name = 'ScAuthExpiredError';
  }
}

/** 403 with a quota / rate reason. Back off. */
export class ScQuotaExceededError extends SearchConsoleApiError {
  constructor(reason: string) {
    super(`Search Console API quota exceeded (${reason}).`, 403, reason);
    this.name = 'ScQuotaExceededError';
  }
}

/** 403 — the connected account has no (or insufficient) access to this property. */
export class ScPermissionError extends SearchConsoleApiError {
  constructor(readonly siteUrl?: string) {
    super(
      siteUrl
        ? `The connected Google account does not have access to "${siteUrl}" in Search Console.`
        : 'The connected Google account does not have the required Search Console access.',
      403,
      'forbidden',
    );
    this.name = 'ScPermissionError';
  }
}

/** 404 — the property does not exist (or was removed). */
export class ScPropertyNotFoundError extends SearchConsoleApiError {
  constructor(readonly siteUrl?: string) {
    super(`Search Console property "${siteUrl ?? 'unknown'}" was not found.`, 404, 'notFound');
    this.name = 'ScPropertyNotFoundError';
  }
}

/** Response did not match the expected schema. */
export class ScMalformedDataError extends SearchConsoleApiError {
  constructor(
    readonly endpoint: string,
    readonly issues: unknown,
  ) {
    super(`Malformed response from ${endpoint}.`, 200, 'malformed');
    this.name = 'ScMalformedDataError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'dailyLimitExceeded',
]);
export function isQuotaReason(reason: string | undefined): boolean {
  return Boolean(reason && QUOTA_REASONS.has(reason));
}
