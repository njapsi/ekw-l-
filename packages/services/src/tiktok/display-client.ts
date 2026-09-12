import { createLogger } from '@growth-agent/observability';
import {
  type DirectPostInput,
  TikTokApiError,
  TikTokMalformedDataError,
  type TikTokClient,
  mapTikTokError,
} from './client.js';
import {
  PublishInitResponse,
  PublishStatusResponse,
  UserInfoResponse,
  VideoListResponse,
} from './schemas.js';

const log = createLogger('tiktok');
const BASE = 'https://open.tiktokapis.com/v2';
const MAX_RETRIES = 2;

const USER_FIELDS = [
  'open_id',
  'union_id',
  'avatar_url',
  'display_name',
  'bio_description',
  'profile_deep_link',
  'is_verified',
  'username',
  'follower_count',
  'following_count',
  'likes_count',
  'video_count',
].join(',');

const VIDEO_FIELDS = [
  'id',
  'create_time',
  'cover_image_url',
  'share_url',
  'embed_link',
  'video_description',
  'title',
  'duration',
  'like_count',
  'comment_count',
  'share_count',
  'view_count',
].join(',');

/**
 * Real TikTok client (Display API v2 + Content Posting API). It does not
 * refresh tokens — `withFreshAccessToken` owns that. On a live
 * `access_token_invalid` it surfaces `TikTokAuthExpiredError` so the resilient
 * wrapper can refresh and retry once.
 */
export class DisplayTikTokClient implements TikTokClient {
  constructor(private readonly accessToken: string) {}

  private async call<T>(
    path: string,
    parse: (v: unknown) => { success: boolean; data?: T; error?: unknown },
    opts: {
      method?: string;
      query?: Record<string, string>;
      body?: unknown;
      requiredScope?: string;
    } = {},
  ): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await fetch(url, {
          method: opts.method ?? 'POST',
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            'content-type': 'application/json; charset=UTF-8',
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        if (attempt <= MAX_RETRIES) {
          await sleep(300 * attempt);
          continue;
        }
        throw new TikTokApiError(
          `Network error calling TikTok: ${(err as Error).message}`,
          'network',
          0,
        );
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new TikTokMalformedDataError(path, 'non-JSON body');
      }

      const err = (json as { error?: { code?: string; message?: string } }).error;
      const code = err?.code ?? 'ok';
      if (code !== 'ok' && code !== '') {
        const mapped = mapTikTokError(path, code, err?.message, opts.requiredScope);
        if (mapped.name === 'TikTokRateLimitError' && attempt <= MAX_RETRIES) {
          log.warn({ path, attempt }, 'tiktok rate-limited; backing off');
          await sleep(1000 * attempt);
          continue;
        }
        throw mapped;
      }
      if (!res.ok && attempt <= MAX_RETRIES && res.status >= 500) {
        await sleep(400 * attempt);
        continue;
      }

      const parsed = parse(json);
      if (!parsed.success) throw new TikTokMalformedDataError(path, parsed.error);
      return parsed.data as T;
    }
  }

  getUserInfo(): Promise<UserInfoResponse> {
    return this.call('/user/info/', (v) => UserInfoResponse.safeParse(v), {
      query: { fields: USER_FIELDS },
      requiredScope: 'user.info.profile',
    });
  }

  listVideos(cursor?: number, maxCount = 20): Promise<VideoListResponse> {
    return this.call('/video/list/', (v) => VideoListResponse.safeParse(v), {
      query: { fields: VIDEO_FIELDS },
      body: { cursor: cursor ?? undefined, max_count: Math.min(20, Math.max(1, maxCount)) },
      requiredScope: 'video.list',
    });
  }

  initDirectPost(input: DirectPostInput): Promise<PublishInitResponse> {
    return this.call('/post/publish/video/init/', (v) => PublishInitResponse.safeParse(v), {
      body: {
        post_info: {
          title: input.title,
          privacy_level: input.privacyLevel,
          disable_comment: input.disableComment ?? false,
          disable_duet: input.disableDuet ?? false,
          disable_stitch: input.disableStitch ?? false,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: input.sourceUrl },
      },
      requiredScope: 'video.publish',
    });
  }

  fetchPublishStatus(publishId: string): Promise<PublishStatusResponse> {
    return this.call('/post/publish/status/fetch/', (v) => PublishStatusResponse.safeParse(v), {
      body: { publish_id: publishId },
      requiredScope: 'video.publish',
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
