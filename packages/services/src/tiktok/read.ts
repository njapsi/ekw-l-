import { type Db, prisma } from '@growth-agent/db';
import {
  type TikTokVideoLike,
  engagementRate,
  performerSplit,
  postingCadence,
  themeClusters,
} from './metrics.js';

/** Org-scoped reads for the TikTok dashboard. Every query filters by organizationId. */

export async function getConnectionSummary(organizationId: string, db: Db = prisma) {
  const conn = await db.oAuthConnection.findFirst({
    where: { organizationId, provider: 'TIKTOK' },
    include: { health: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!conn) return null;
  return {
    id: conn.id,
    status: conn.status,
    displayName: conn.displayName,
    scopes: conn.scopes,
    canPublish: conn.scopes.includes('video.publish'),
    hasStats: conn.scopes.includes('user.info.stats'),
    lastRefreshedAt: conn.lastRefreshedAt,
    lastError: conn.lastError,
    health: conn.health
      ? { ok: conn.health.ok, detail: conn.health.detail, lastCheckAt: conn.health.lastCheckAt }
      : null,
  };
}

export async function getPrimaryAccount(organizationId: string, db: Db = prisma) {
  return db.tikTokAccount.findFirst({
    where: { organizationId },
    orderBy: { followerCount: 'desc' },
  });
}

export async function getRecentSyncRuns(organizationId: string, db: Db = prisma) {
  return db.tikTokSyncRun.findMany({
    where: { organizationId },
    orderBy: { startedAt: 'desc' },
    take: 10,
  });
}

function toVideoLike(v: {
  videoId: string;
  caption: string | null;
  createTime: Date;
  durationSec: number | null;
  viewCount: bigint | null;
  likeCount: bigint | null;
  commentCount: bigint | null;
  shareCount: bigint | null;
  hashtags: string[];
}): TikTokVideoLike {
  return {
    videoId: v.videoId,
    caption: v.caption,
    createTime: v.createTime,
    durationSec: v.durationSec,
    viewCount: v.viewCount,
    likeCount: v.likeCount,
    commentCount: v.commentCount,
    shareCount: v.shareCount,
    hashtags: v.hashtags,
  };
}

export async function getAccountOverview(organizationId: string, db: Db = prisma) {
  const account = await getPrimaryAccount(organizationId, db);
  if (!account) return null;

  const videos = await db.tikTokVideo.findMany({
    where: { tikTokAccountId: account.id },
    orderBy: { createTime: 'desc' },
    take: 200,
  });
  const vl = videos.map(toVideoLike);
  const cadence = postingCadence(vl);
  const split = performerSplit(vl);

  return {
    account: {
      id: account.id,
      openId: account.openId,
      username: account.username,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      isVerified: account.isVerified,
      profileDeepLink: account.profileDeepLink,
      followerCount: account.followerCount ? account.followerCount.toString() : null,
      likesCount: account.likesCount ? account.likesCount.toString() : null,
      videoCountStat: account.videoCountStat,
      lastSyncedAt: account.lastSyncedAt,
      lastVideoSyncAt: account.lastVideoSyncAt,
    },
    counts: { videosSynced: videos.length },
    cadence,
    performers: {
      high: split.high.length,
      low: split.low.length,
      medianViews: Math.round(split.median),
    },
    themes: themeClusters(vl).map((t) => ({
      tag: t.tag,
      videos: t.videoIds.length,
      totalViews: t.totalViews,
    })),
  };
}

export async function listVideosPage(
  organizationId: string,
  opts: { cursor?: string; limit?: number; sort?: 'recent' | 'views' } = {},
  db: Db = prisma,
) {
  const limit = Math.min(50, Math.max(5, opts.limit ?? 25));
  const rows = await db.tikTokVideo.findMany({
    where: { organizationId },
    orderBy: opts.sort === 'views' ? { viewCount: 'desc' } : { createTime: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    videos: page.map((v) => ({
      id: v.id,
      videoId: v.videoId,
      caption: v.caption,
      createTime: v.createTime,
      durationSec: v.durationSec,
      coverImageUrl: v.coverImageUrl,
      shareUrl: v.shareUrl,
      hashtags: v.hashtags,
      viewCount: v.viewCount ? v.viewCount.toString() : null,
      likeCount: v.likeCount ? v.likeCount.toString() : null,
      commentCount: v.commentCount ? v.commentCount.toString() : null,
      shareCount: v.shareCount ? v.shareCount.toString() : null,
      engagementRatePct: (() => {
        const r = engagementRate(toVideoLike(v));
        return r == null ? null : Number((r * 100).toFixed(2));
      })(),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export function listRecommendations(organizationId: string, db: Db = prisma) {
  return db.recommendation.findMany({
    where: { organizationId, domain: 'TIKTOK' },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });
}

export function listContentIdeas(organizationId: string, db: Db = prisma) {
  return db.contentIdea.findMany({
    where: { organizationId, platform: 'TIKTOK' },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export function latestAnalystRun(organizationId: string, db: Db = prisma) {
  return db.agentRun.findFirst({
    where: { organizationId, agent: 'tiktok-analyst' },
    orderBy: { createdAt: 'desc' },
  });
}
