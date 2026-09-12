import { type Db, type OAuthConnection, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { ConnectionUnavailableError, withFreshAccessToken } from '../integrations/connections.js';
import {
  type SearchAnalyticsQuery,
  type SearchConsoleClient,
  ScAuthExpiredError,
} from './client.js';
import { GoogleSearchConsoleClient } from './google-client.js';
import type {
  SearchAnalyticsQueryResponse,
  SitemapResource,
  SitesListResponse,
  UrlInspectionResponse,
} from './schemas.js';

const log = createLogger('searchconsole');

/**
 * The production `SearchConsoleClient`: a fresh access token from the connection
 * for every call and, if the API still returns 401, one forced token refresh +
 * retry before giving up. Mirrors `ResilientYouTubeClient`.
 */
export class ResilientSearchConsoleClient implements SearchConsoleClient {
  constructor(
    private connection: OAuthConnection,
    private readonly redirectUri: string,
    private readonly db: Db = prisma,
  ) {}

  private async run<T>(op: (inner: SearchConsoleClient) => Promise<T>): Promise<T> {
    const call = (token: string) => op(new GoogleSearchConsoleClient(token));
    try {
      return await withFreshAccessToken(this.connection, this.redirectUri, call, this.db);
    } catch (err) {
      if (!(err instanceof ScAuthExpiredError)) throw err;
      log.warn(
        { connectionId: this.connection.id },
        'Search Console API rejected token; forcing refresh + retry',
      );
      await this.db.oAuthConnection.update({
        where: { id: this.connection.id },
        data: { status: 'EXPIRED' },
      });
      const fresh = await this.db.oAuthConnection.findUnique({
        where: { id: this.connection.id },
      });
      if (!fresh) throw new ConnectionUnavailableError('Connection no longer exists.');
      this.connection = fresh;
      return withFreshAccessToken(fresh, this.redirectUri, call, this.db);
    }
  }

  listSites(): Promise<SitesListResponse> {
    return this.run((c) => c.listSites());
  }
  getSite(siteUrl: string): Promise<{ siteUrl: string; permissionLevel?: string }> {
    return this.run((c) => c.getSite(siteUrl));
  }
  querySearchAnalytics(query: SearchAnalyticsQuery): Promise<SearchAnalyticsQueryResponse> {
    return this.run((c) => c.querySearchAnalytics(query));
  }
  listSitemaps(siteUrl: string): Promise<SitemapResource[]> {
    return this.run((c) => c.listSitemaps(siteUrl));
  }
  inspectUrl(siteUrl: string, inspectionUrl: string): Promise<UrlInspectionResponse> {
    return this.run((c) => c.inspectUrl(siteUrl, inspectionUrl));
  }
}
