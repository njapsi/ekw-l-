import { type Db, type OAuthConnection, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { ConnectionUnavailableError, withFreshAccessToken } from '../integrations/connections.js';
import {
  type AnalyticsQuery,
  AuthExpiredError,
  type QuotaTracked,
  type YouTubeClient,
} from './client.js';
import { GoogleYouTubeClient } from './google-client.js';
import type {
  AnalyticsQueryResponse,
  ChannelListResponse,
  PlaylistItemsResponse,
  VideoListResponse,
} from './schemas.js';

const log = createLogger('youtube');

/**
 * The production `YouTubeClient`: gets a fresh access token from the connection
 * for every call and, if the API still returns 401, forces one token refresh
 * and retries the call once before giving up.
 */
export class ResilientYouTubeClient implements YouTubeClient {
  constructor(
    private connection: OAuthConnection,
    private readonly redirectUri: string,
    private readonly db: Db = prisma,
  ) {}

  private async run<T>(op: (inner: YouTubeClient) => Promise<T>): Promise<T> {
    const call = (token: string) => op(new GoogleYouTubeClient(token));
    try {
      return await withFreshAccessToken(this.connection, this.redirectUri, call, this.db);
    } catch (err) {
      if (!(err instanceof AuthExpiredError)) throw err;
      log.warn({ connectionId: this.connection.id }, 'API rejected token; forcing refresh + retry');
      await this.db.oAuthConnection.update({
        where: { id: this.connection.id },
        data: { status: 'EXPIRED' },
      });
      const fresh = await this.db.oAuthConnection.findUnique({ where: { id: this.connection.id } });
      if (!fresh) throw new ConnectionUnavailableError('Connection no longer exists.');
      this.connection = fresh;
      return withFreshAccessToken(fresh, this.redirectUri, call, this.db);
    }
  }

  listMyChannels(): Promise<QuotaTracked<ChannelListResponse>> {
    return this.run((c) => c.listMyChannels());
  }
  getChannels(ids: string[]): Promise<QuotaTracked<ChannelListResponse>> {
    return this.run((c) => c.getChannels(ids));
  }
  listPlaylistItems(
    playlistId: string,
    pageToken?: string,
  ): Promise<QuotaTracked<PlaylistItemsResponse>> {
    return this.run((c) => c.listPlaylistItems(playlistId, pageToken));
  }
  getVideos(ids: string[]): Promise<QuotaTracked<VideoListResponse>> {
    return this.run((c) => c.getVideos(ids));
  }
  queryAnalytics(query: AnalyticsQuery): Promise<QuotaTracked<AnalyticsQueryResponse>> {
    return this.run((c) => c.queryAnalytics(query));
  }
}
