import {
  type DirectPostInput,
  TikTokApiError,
  TikTokAuthExpiredError,
  TikTokMalformedDataError,
  TikTokPermissionError,
  TikTokPublishError,
  TikTokRateLimitError,
  type TikTokClient,
} from './client.js';
import {
  PublishInitResponse,
  PublishStatusResponse,
  UserInfoResponse,
  VideoListResponse,
} from './schemas.js';

export interface FixtureTikTokVideo {
  id: string;
  description?: string;
  createTime: number; // epoch seconds
  durationSec?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  viewCount?: number;
  shareUrl?: string;
  coverImageUrl?: string;
}

export interface FixtureTikTokUser {
  openId: string;
  username?: string;
  displayName?: string;
  followerCount?: number;
  followingCount?: number;
  likesCount?: number;
  videoCount?: number;
  isVerified?: boolean;
}

export type TikTokFault =
  | 'auth-expired-once'
  | 'rate-limited'
  | 'no-video-list-scope'
  | 'no-stats-scope'
  | 'no-publish-scope'
  | 'malformed-videos'
  | 'empty'
  | 'publish-fail'
  | 'network-error';

export interface TikTokFixtureConfig {
  user: FixtureTikTokUser;
  videos: FixtureTikTokVideo[];
  faults?: Set<TikTokFault>;
  /** publish_id → sequence of statuses returned on successive polls. */
  publishStatusSequence?: string[];
}

export class FixturesTikTokClient implements TikTokClient {
  private authFailsRemaining = 0;
  private pollCount = 0;
  constructor(private readonly cfg: TikTokFixtureConfig) {
    if (cfg.faults?.has('auth-expired-once')) this.authFailsRemaining = 1;
  }

  private guard(): void {
    if (this.cfg.faults?.has('network-error')) {
      throw new TikTokApiError('Network error calling TikTok: ECONNRESET', 'network', 0);
    }
    if (this.cfg.faults?.has('rate-limited')) throw new TikTokRateLimitError(30);
    if (this.authFailsRemaining > 0) {
      this.authFailsRemaining--;
      throw new TikTokAuthExpiredError();
    }
  }

  getUserInfo(): Promise<UserInfoResponse> {
    this.guard();
    const u = this.cfg.user;
    const hasStats = !this.cfg.faults?.has('no-stats-scope');
    return Promise.resolve(
      UserInfoResponse.parse({
        data: {
          user: {
            open_id: u.openId,
            username: u.username,
            display_name: u.displayName,
            is_verified: u.isVerified ?? false,
            ...(hasStats
              ? {
                  follower_count: u.followerCount,
                  following_count: u.followingCount,
                  likes_count: u.likesCount,
                  video_count: u.videoCount,
                }
              : {}),
          },
        },
        error: { code: 'ok' },
      }),
    );
  }

  listVideos(cursor?: number, maxCount = 20): Promise<VideoListResponse> {
    this.guard();
    if (this.cfg.faults?.has('no-video-list-scope')) {
      throw new TikTokPermissionError('video.list');
    }
    if (this.cfg.faults?.has('malformed-videos')) {
      throw new TikTokMalformedDataError('/video/list/', 'videos[0].id missing');
    }
    const all = [...this.cfg.videos].sort((a, b) => b.createTime - a.createTime);
    const start = cursor ? all.findIndex((v) => v.createTime < cursor) : 0;
    const slice = start < 0 ? [] : all.slice(start, start + maxCount);
    const last = slice[slice.length - 1];
    return Promise.resolve(
      VideoListResponse.parse({
        data: {
          videos: (this.cfg.faults?.has('empty') ? [] : slice).map((v) => ({
            id: v.id,
            create_time: v.createTime,
            video_description: v.description,
            duration: v.durationSec,
            cover_image_url: v.coverImageUrl,
            share_url: v.shareUrl,
            like_count: v.likeCount,
            comment_count: v.commentCount,
            share_count: v.shareCount,
            view_count: v.viewCount,
          })),
          cursor: last ? last.createTime : cursor,
          has_more: start >= 0 && start + maxCount < all.length && !this.cfg.faults?.has('empty'),
        },
        error: { code: 'ok' },
      }),
    );
  }

  initDirectPost(_input: DirectPostInput): Promise<PublishInitResponse> {
    this.guard();
    if (this.cfg.faults?.has('no-publish-scope')) throw new TikTokPermissionError('video.publish');
    if (this.cfg.faults?.has('publish-fail')) {
      throw new TikTokPublishError(
        'spam risk: too many pending shares',
        'spam_risk_too_many_pending_share',
      );
    }
    return Promise.resolve(
      PublishInitResponse.parse({
        data: { publish_id: `pub_${Date.now()}` },
        error: { code: 'ok' },
      }),
    );
  }

  fetchPublishStatus(_publishId: string): Promise<PublishStatusResponse> {
    this.guard();
    const seq = this.cfg.publishStatusSequence ?? ['PROCESSING_UPLOAD', 'PUBLISH_COMPLETE'];
    const status = seq[Math.min(this.pollCount, seq.length - 1)]!;
    this.pollCount++;
    return Promise.resolve(
      PublishStatusResponse.parse({
        data: {
          status,
          fail_reason: status === 'FAILED' ? 'processing failed' : undefined,
          publicaly_available_post_id:
            status === 'PUBLISH_COMPLETE' ? ['7000000000000000000'] : undefined,
        },
        error: { code: 'ok' },
      }),
    );
  }
}
