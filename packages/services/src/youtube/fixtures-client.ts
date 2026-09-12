import {
  type AnalyticsQuery,
  AuthExpiredError,
  MalformedApiDataError,
  QuotaExceededError,
  type QuotaTracked,
  type YouTubeClient,
  YouTubeApiError,
} from './client.js';
import {
  AnalyticsQueryResponse,
  ChannelListResponse,
  PlaylistItemsResponse,
  VideoListResponse,
} from './schemas.js';

export interface FixtureVideo {
  videoId: string;
  title: string;
  description?: string;
  publishedAt: string;
  durationIso?: string;
  tags?: string[];
  categoryId?: string;
  viewCount?: string;
  likeCount?: string;
  commentCount?: string;
}

export interface FixtureChannel {
  channelId: string;
  title: string;
  uploadsPlaylistId: string;
  subscriberCount?: string;
  hiddenSubscriberCount?: boolean;
  viewCount?: string;
  videoCount?: string;
  publishedAt?: string;
}

export type FixtureFault =
  | 'auth-expired-once'
  | 'quota-exceeded'
  | 'server-error'
  | 'malformed-videos'
  | 'empty-analytics'
  | 'network-error';

export interface FixtureConfig {
  channels: FixtureChannel[];
  videos: FixtureVideo[];
  /** date (YYYY-MM-DD) → per-day analytics row for CHANNEL. */
  analyticsByDate?: Record<
    string,
    {
      views: number;
      estimatedMinutesWatched: number;
      likes: number;
      comments: number;
      shares: number;
      subscribersGained: number;
      subscribersLost: number;
    }
  >;
  faults?: Set<FixtureFault>;
}

/**
 * In-memory YouTube client for tests. Deterministic, and able to inject each
 * failure mode the Phase 3 test plan requires.
 */
export class FixturesYouTubeClient implements YouTubeClient {
  private authFailsRemaining = 0;
  constructor(private readonly cfg: FixtureConfig) {
    if (cfg.faults?.has('auth-expired-once')) this.authFailsRemaining = 1;
  }

  private guard(): void {
    if (this.cfg.faults?.has('network-error')) {
      throw new YouTubeApiError('Network error calling YouTube API: ECONNRESET', 0, 'network');
    }
    if (this.cfg.faults?.has('server-error')) {
      throw new YouTubeApiError('YouTube API returned 503', 503, 'backendError');
    }
    if (this.cfg.faults?.has('quota-exceeded')) {
      throw new QuotaExceededError('quotaExceeded');
    }
    if (this.authFailsRemaining > 0) {
      this.authFailsRemaining--;
      throw new AuthExpiredError();
    }
  }

  listMyChannels(): Promise<QuotaTracked<ChannelListResponse>> {
    this.guard();
    return Promise.resolve({
      data: ChannelListResponse.parse({
        items: this.cfg.channels.map((c) => ({
          id: c.channelId,
          snippet: { title: c.title, publishedAt: c.publishedAt },
          contentDetails: { relatedPlaylists: { uploads: c.uploadsPlaylistId } },
          statistics: {
            subscriberCount: c.subscriberCount,
            hiddenSubscriberCount: c.hiddenSubscriberCount ?? false,
            viewCount: c.viewCount,
            videoCount: c.videoCount,
          },
        })),
      }),
      quotaUnits: 1,
    });
  }

  getChannels(channelIds: string[]): Promise<QuotaTracked<ChannelListResponse>> {
    this.guard();
    const set = new Set(channelIds);
    return Promise.resolve({
      data: ChannelListResponse.parse({
        items: this.cfg.channels
          .filter((c) => set.has(c.channelId))
          .map((c) => ({
            id: c.channelId,
            snippet: { title: c.title, publishedAt: c.publishedAt },
            contentDetails: { relatedPlaylists: { uploads: c.uploadsPlaylistId } },
            statistics: {
              subscriberCount: c.subscriberCount,
              hiddenSubscriberCount: c.hiddenSubscriberCount ?? false,
              viewCount: c.viewCount,
              videoCount: c.videoCount,
            },
          })),
      }),
      quotaUnits: 1,
    });
  }

  listPlaylistItems(
    _playlistId: string,
    pageToken?: string,
  ): Promise<QuotaTracked<PlaylistItemsResponse>> {
    this.guard();
    // Single page of all fixture videos, newest first.
    if (pageToken) return Promise.resolve({ data: { items: [] }, quotaUnits: 1 });
    const items = [...this.cfg.videos]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((v) => ({ contentDetails: { videoId: v.videoId, videoPublishedAt: v.publishedAt } }));
    return Promise.resolve({ data: PlaylistItemsResponse.parse({ items }), quotaUnits: 1 });
  }

  getVideos(videoIds: string[]): Promise<QuotaTracked<VideoListResponse>> {
    this.guard();
    if (this.cfg.faults?.has('malformed-videos')) {
      throw new MalformedApiDataError('videos.list', 'items[0].id missing');
    }
    const set = new Set(videoIds);
    return Promise.resolve({
      data: VideoListResponse.parse({
        items: this.cfg.videos
          .filter((v) => set.has(v.videoId))
          .map((v) => ({
            id: v.videoId,
            snippet: {
              title: v.title,
              description: v.description,
              publishedAt: v.publishedAt,
              tags: v.tags,
              categoryId: v.categoryId,
            },
            contentDetails: { duration: v.durationIso },
            status: { privacyStatus: 'public', madeForKids: false },
            statistics: {
              viewCount: v.viewCount,
              likeCount: v.likeCount,
              commentCount: v.commentCount,
            },
          })),
      }),
      quotaUnits: 1,
    });
  }

  queryAnalytics(query: AnalyticsQuery): Promise<QuotaTracked<AnalyticsQueryResponse>> {
    this.guard();
    if (this.cfg.faults?.has('empty-analytics') || !this.cfg.analyticsByDate) {
      return Promise.resolve({
        data: AnalyticsQueryResponse.parse({
          columnHeaders: [{ name: 'day' }, ...query.metrics.map((m) => ({ name: m }))],
          rows: [],
        }),
        quotaUnits: 1,
      });
    }
    const rows = Object.entries(this.cfg.analyticsByDate)
      .filter(([d]) => d >= query.startDate && d <= query.endDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, m]) => [
        d,
        ...query.metrics.map((metric) => {
          const map: Record<string, number> = {
            views: m.views,
            estimatedMinutesWatched: m.estimatedMinutesWatched,
            likes: m.likes,
            comments: m.comments,
            shares: m.shares,
            subscribersGained: m.subscribersGained,
            subscribersLost: m.subscribersLost,
          };
          return map[metric] ?? 0;
        }),
      ]);
    return Promise.resolve({
      data: AnalyticsQueryResponse.parse({
        columnHeaders: [{ name: 'day' }, ...query.metrics.map((m) => ({ name: m }))],
        rows,
      }),
      quotaUnits: 1,
    });
  }
}
