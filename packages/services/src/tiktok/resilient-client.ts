import { type Db, type OAuthConnection, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { ConnectionUnavailableError, withFreshAccessToken } from '../integrations/connections.js';
import { type DirectPostInput, TikTokAuthExpiredError, type TikTokClient } from './client.js';
import { DisplayTikTokClient } from './display-client.js';
import type {
  PublishInitResponse,
  PublishStatusResponse,
  UserInfoResponse,
  VideoListResponse,
} from './schemas.js';

const log = createLogger('tiktok');

/** Production `TikTokClient`: fresh token per call + one forced refresh + retry on 401. */
export class ResilientTikTokClient implements TikTokClient {
  constructor(
    private connection: OAuthConnection,
    private readonly redirectUri: string,
    private readonly db: Db = prisma,
  ) {}

  private async run<T>(op: (inner: TikTokClient) => Promise<T>): Promise<T> {
    const call = (token: string) => op(new DisplayTikTokClient(token));
    try {
      return await withFreshAccessToken(this.connection, this.redirectUri, call, this.db);
    } catch (err) {
      if (!(err instanceof TikTokAuthExpiredError)) throw err;
      log.warn(
        { connectionId: this.connection.id },
        'TikTok rejected token; forcing refresh + retry',
      );
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

  getUserInfo(): Promise<UserInfoResponse> {
    return this.run((c) => c.getUserInfo());
  }
  listVideos(cursor?: number, maxCount?: number): Promise<VideoListResponse> {
    return this.run((c) => c.listVideos(cursor, maxCount));
  }
  initDirectPost(input: DirectPostInput): Promise<PublishInitResponse> {
    return this.run((c) => c.initDirectPost(input));
  }
  fetchPublishStatus(publishId: string): Promise<PublishStatusResponse> {
    return this.run((c) => c.fetchPublishStatus(publishId));
  }
}
