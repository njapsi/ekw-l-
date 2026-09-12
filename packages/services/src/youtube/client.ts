import type {
  AnalyticsQueryResponse,
  ChannelListResponse,
  PlaylistItemsResponse,
  VideoListResponse,
} from './schemas.js';

/**
 * Provider-agnostic YouTube client. `google-client.ts` is the real
 * implementation; `fixtures-client.ts` is used by tests. Every method reports
 * the API-quota units it spent so the sync engine can budget
 * (docs/YOUTUBE-INTEGRATION.md).
 *
 * Data API v3 quota costs (units): channels.list=1, playlistItems.list=1,
 * videos.list=1. Analytics API queries=1 (but rate-limited separately).
 */
export interface QuotaTracked<T> {
  data: T;
  quotaUnits: number;
}

export interface AnalyticsQuery {
  ids: string; // "channel==MINE" or "channel==UC..."
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  metrics: string[];
  dimensions?: string[];
  filters?: string;
  sort?: string;
  maxResults?: number;
}

export interface YouTubeClient {
  /** channels.list?mine=true — the channels the token owner manages. */
  listMyChannels(): Promise<QuotaTracked<ChannelListResponse>>;
  getChannels(channelIds: string[]): Promise<QuotaTracked<ChannelListResponse>>;
  listPlaylistItems(
    playlistId: string,
    pageToken?: string,
  ): Promise<QuotaTracked<PlaylistItemsResponse>>;
  getVideos(videoIds: string[]): Promise<QuotaTracked<VideoListResponse>>;
  queryAnalytics(query: AnalyticsQuery): Promise<QuotaTracked<AnalyticsQueryResponse>>;
}

// --- Typed errors ----------------------------------------------------------

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

/** 403 with reason quotaExceeded / rateLimitExceeded / userRateLimitExceeded. */
export class QuotaExceededError extends YouTubeApiError {
  constructor(reason: string) {
    super(`YouTube API quota exceeded (${reason}).`, 403, reason);
    this.name = 'QuotaExceededError';
  }
}

/** 401 — token invalid/expired; caller should refresh and retry once. */
export class AuthExpiredError extends YouTubeApiError {
  constructor() {
    super('YouTube API rejected the access token (401).', 401, 'authError');
    this.name = 'AuthExpiredError';
  }
}

/** Response did not match the expected schema. */
export class MalformedApiDataError extends YouTubeApiError {
  constructor(
    readonly endpoint: string,
    readonly issues: unknown,
  ) {
    super(`Malformed response from ${endpoint}.`, 200, 'malformed');
    this.name = 'MalformedApiDataError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}
