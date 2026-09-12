import { createLogger } from '@growth-agent/observability';
import {
  AnalyticsQueryResponse,
  ChannelListResponse,
  PlaylistItemsResponse,
  VideoListResponse,
} from './schemas.js';
import {
  type AnalyticsQuery,
  AuthExpiredError,
  MalformedApiDataError,
  QuotaExceededError,
  type QuotaTracked,
  type YouTubeClient,
  YouTubeApiError,
  isRetryableStatus,
} from './client.js';

const log = createLogger('youtube');
const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';
const MAX_RETRIES = 3;

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
}

/**
 * Real YouTube client. Retries transient 5xx with jittered backoff, maps 401 →
 * `AuthExpiredError` (the caller refreshes and retries once) and 403
 * quota/rate reasons → `QuotaExceededError`. It does **not** refresh tokens
 * itself — `withFreshAccessToken` owns that.
 */
export class GoogleYouTubeClient implements YouTubeClient {
  constructor(private readonly accessToken: string) {}

  private async request(url: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' },
        });
      } catch (err) {
        if (attempt <= MAX_RETRIES) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new YouTubeApiError(
          `Network error calling YouTube API: ${(err as Error).message}`,
          0,
          'network',
        );
      }

      const text = await res.text();
      if (res.ok) {
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          throw new MalformedApiDataError(url, 'non-JSON body');
        }
      }

      let body: GoogleErrorBody = {};
      try {
        body = text ? (JSON.parse(text) as GoogleErrorBody) : {};
      } catch {
        /* keep empty */
      }
      const reason = body.error?.errors?.[0]?.reason ?? '';

      if (res.status === 401) throw new AuthExpiredError();
      if (
        res.status === 403 &&
        [
          'quotaExceeded',
          'rateLimitExceeded',
          'userRateLimitExceeded',
          'dailyLimitExceeded',
        ].includes(reason)
      ) {
        throw new QuotaExceededError(reason || 'quotaExceeded');
      }
      if (isRetryableStatus(res.status) && attempt <= MAX_RETRIES) {
        log.warn({ status: res.status, attempt }, 'retrying YouTube API call');
        await sleep(backoff(attempt));
        continue;
      }
      throw new YouTubeApiError(
        body.error?.message ?? `YouTube API returned ${res.status}`,
        res.status,
        reason || undefined,
      );
    }
  }

  async listMyChannels(): Promise<QuotaTracked<ChannelListResponse>> {
    const url = `${DATA_API}/channels?${new URLSearchParams({
      part: 'snippet,contentDetails,statistics',
      mine: 'true',
      maxResults: '50',
    })}`;
    const raw = await this.request(url);
    return { data: parse(ChannelListResponse, url, raw), quotaUnits: 1 };
  }

  async getChannels(channelIds: string[]): Promise<QuotaTracked<ChannelListResponse>> {
    if (channelIds.length === 0) return { data: { items: [] }, quotaUnits: 0 };
    const url = `${DATA_API}/channels?${new URLSearchParams({
      part: 'snippet,contentDetails,statistics',
      id: channelIds.join(','),
      maxResults: '50',
    })}`;
    const raw = await this.request(url);
    return { data: parse(ChannelListResponse, url, raw), quotaUnits: 1 };
  }

  async listPlaylistItems(
    playlistId: string,
    pageToken?: string,
  ): Promise<QuotaTracked<PlaylistItemsResponse>> {
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId,
      maxResults: '50',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${DATA_API}/playlistItems?${params}`;
    const raw = await this.request(url);
    return { data: parse(PlaylistItemsResponse, url, raw), quotaUnits: 1 };
  }

  async getVideos(videoIds: string[]): Promise<QuotaTracked<VideoListResponse>> {
    if (videoIds.length === 0) return { data: { items: [] }, quotaUnits: 0 };
    const url = `${DATA_API}/videos?${new URLSearchParams({
      part: 'snippet,contentDetails,statistics,status',
      id: videoIds.slice(0, 50).join(','),
      maxResults: '50',
    })}`;
    const raw = await this.request(url);
    return { data: parse(VideoListResponse, url, raw), quotaUnits: 1 };
  }

  async queryAnalytics(query: AnalyticsQuery): Promise<QuotaTracked<AnalyticsQueryResponse>> {
    const params = new URLSearchParams({
      ids: query.ids,
      startDate: query.startDate,
      endDate: query.endDate,
      metrics: query.metrics.join(','),
    });
    if (query.dimensions?.length) params.set('dimensions', query.dimensions.join(','));
    if (query.filters) params.set('filters', query.filters);
    if (query.sort) params.set('sort', query.sort);
    if (query.maxResults) params.set('maxResults', String(query.maxResults));
    const url = `${ANALYTICS_API}?${params}`;
    const raw = await this.request(url);
    return { data: parse(AnalyticsQueryResponse, url, raw), quotaUnits: 1 };
  }
}

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
  url: string,
  raw: unknown,
): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new MalformedApiDataError(url, r.error);
  return r.data as T;
}

function backoff(attempt: number): number {
  return Math.min(8000, 2 ** attempt * 250) + Math.random() * 200;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
