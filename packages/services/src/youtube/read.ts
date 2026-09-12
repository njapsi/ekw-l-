import { type Db, prisma } from '@growth-agent/db';
import {
  type VideoLike,
  engagementRate,
  performerSplit,
  publishingCadence,
  windowTotals,
} from './metrics.js';

/**
 * Org-scoped read helpers for the YouTube dashboard. Every query is filtered by
 * `organizationId`; a caller can never read another tenant's channel.
 */

export async function getConnectionSummary(organizationId: string, db: Db = prisma) {
  const conn = await db.oAuthConnection.findFirst({
    where: { organizationId, provider: 'YOUTUBE' },
    include: { health: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!conn) return null;
  return {
    id: conn.id,
    status: conn.status,
    displayName: conn.displayName,
    scopes: conn.scopes,
    hasRevenueScope: conn.scopes.includes(
      'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
    ),
    lastRefreshedAt: conn.lastRefreshedAt,
    lastError: conn.lastError,
    health: conn.health
      ? {
          ok: conn.health.ok,
          detail: conn.health.detail,
          quotaUnitsUsedToday: conn.health.quotaUnitsUsedToday,
          lastCheckAt: conn.health.lastCheckAt,
        }
      : null,
  };
}

export async function getPrimaryChannel(organizationId: string, db: Db = prisma) {
  return db.youTubeChannel.findFirst({
    where: { organizationId },
    orderBy: { subscriberCount: 'desc' },
  });
}

export async function listChannels(organizationId: string, db: Db = prisma) {
  return db.youTubeChannel.findMany({ where: { organizationId }, orderBy: { title: 'asc' } });
}

export async function getRecentSyncRuns(organizationId: string, db: Db = prisma) {
  return db.youTubeSyncRun.findMany({
    where: { organizationId },
    orderBy: { startedAt: 'desc' },
    take: 10,
  });
}

function toVideoLike(v: {
  videoId: string;
  title: string;
  publishedAt: Date;
  durationSeconds: number | null;
  viewCount: bigint | null;
  likeCount: bigint | null;
  commentCount: bigint | null;
  tags: string[];
}): VideoLike {
  return {
    videoId: v.videoId,
    title: v.title,
    publishedAt: v.publishedAt,
    durationSeconds: v.durationSeconds,
    viewCount: v.viewCount,
    likeCount: v.likeCount,
    commentCount: v.commentCount,
    tags: v.tags,
  };
}

export async function getChannelOverview(organizationId: string, db: Db = prisma) {
  const channel = await getPrimaryChannel(organizationId, db);
  if (!channel) return null;

  const videos = await db.youTubeVideo.findMany({
    where: { youTubeChannelId: channel.id },
    orderBy: { publishedAt: 'desc' },
    take: 200,
    // No `description` — this view only aggregates cadence/performer/window
    // stats from the fields below, never the (potentially large) video body.
    select: {
      videoId: true,
      title: true,
      publishedAt: true,
      durationSeconds: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      tags: true,
    },
  });
  const daily = await db.youTubeMetric.findMany({
    where: { organizationId, subjectType: 'CHANNEL', subjectId: channel.channelId },
    orderBy: { date: 'asc' },
  });

  const vl = videos.map(toVideoLike);
  const dl = daily.map((d) => ({
    date: d.date,
    views: d.views,
    estimatedMinutesWatched: d.estimatedMinutesWatched,
    likes: d.likes,
    comments: d.comments,
    shares: d.shares,
    subscribersGained: d.subscribersGained,
    subscribersLost: d.subscribersLost,
    estimatedRevenue: d.estimatedRevenue ? Number(d.estimatedRevenue) : null,
  }));

  const hasAnalytics = dl.length > 0;
  const cadence = publishingCadence(vl);
  const split = performerSplit(vl);
  const w28 = hasAnalytics ? windowTotals(dl, 28) : null;
  const w365 = hasAnalytics ? windowTotals(dl, 365) : null;

  return {
    channel: {
      id: channel.id,
      channelId: channel.channelId,
      title: channel.title,
      handle: channel.handle,
      thumbnailUrl: channel.thumbnailUrl,
      subscriberCount: channel.subscriberCount ? channel.subscriberCount.toString() : null,
      hiddenSubscriberCount: channel.hiddenSubscriberCount,
      viewCount: channel.viewCount ? channel.viewCount.toString() : null,
      videoCount: channel.videoCount,
      publishedAt: channel.publishedAt,
      lastSyncedAt: channel.lastSyncedAt,
      lastVideoSyncAt: channel.lastVideoSyncAt,
      lastAnalyticsSyncAt: channel.lastAnalyticsSyncAt,
    },
    counts: { videosSynced: videos.length, analyticsDays: daily.length },
    hasAnalytics,
    cadence,
    performers: {
      high: split.high.length,
      low: split.low.length,
      medianViews: Math.round(split.median),
    },
    windows: {
      last28d: w28
        ? {
            views: w28.views,
            watchHours: Math.round(w28.watchHours),
            netSubscribers: w28.netSubscribers,
            estimatedRevenue: w28.estimatedRevenue,
          }
        : null,
      last365d: w365
        ? {
            views: w365.views,
            watchHours: Math.round(w365.watchHours),
            netSubscribers: w365.netSubscribers,
          }
        : null,
    },
  };
}

export async function listVideosPage(
  organizationId: string,
  opts: { cursor?: string; limit?: number; sort?: 'recent' | 'views' } = {},
  db: Db = prisma,
) {
  const limit = Math.min(50, Math.max(5, opts.limit ?? 25));
  const rows = await db.youTubeVideo.findMany({
    where: { organizationId },
    orderBy: opts.sort === 'views' ? { viewCount: 'desc' } : { publishedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    // No `description` — the page cards below never render the video body.
    select: {
      id: true,
      videoId: true,
      title: true,
      publishedAt: true,
      durationSeconds: true,
      thumbnailUrl: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      tags: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    videos: page.map((v) => ({
      id: v.id,
      videoId: v.videoId,
      title: v.title,
      publishedAt: v.publishedAt,
      durationSeconds: v.durationSeconds,
      thumbnailUrl: v.thumbnailUrl,
      viewCount: v.viewCount ? v.viewCount.toString() : null,
      likeCount: v.likeCount ? v.likeCount.toString() : null,
      commentCount: v.commentCount ? v.commentCount.toString() : null,
      engagementRatePct: (() => {
        const r = engagementRate(toVideoLike(v));
        return r == null ? null : Number((r * 100).toFixed(2));
      })(),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getGrowthSeries(organizationId: string, db: Db = prisma) {
  const channel = await getPrimaryChannel(organizationId, db);
  if (!channel) return null;
  const rows = await db.youTubeMetric.findMany({
    where: { organizationId, subjectType: 'CHANNEL', subjectId: channel.channelId },
    orderBy: { date: 'asc' },
  });
  return {
    channelId: channel.channelId,
    hasData: rows.length > 0,
    series: rows.map((d) => ({
      date: d.date.toISOString().slice(0, 10),
      views: Number(d.views),
      watchHours: Math.round(Number(d.estimatedMinutesWatched) / 60),
      netSubscribers: Number(d.subscribersGained) - Number(d.subscribersLost),
      estimatedRevenue: d.estimatedRevenue ? Number(d.estimatedRevenue) : null,
    })),
  };
}

export async function listYouTubeRecommendations(organizationId: string, db: Db = prisma) {
  return db.recommendation.findMany({
    where: { organizationId, domain: 'YOUTUBE' },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });
}

export async function listYouTubeContentIdeas(organizationId: string, db: Db = prisma) {
  return db.contentIdea.findMany({
    where: { organizationId, platform: 'YOUTUBE' },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function latestAnalystRun(organizationId: string, db: Db = prisma) {
  return db.agentRun.findFirst({
    where: { organizationId, agent: 'youtube-analyst' },
    orderBy: { createdAt: 'desc' },
  });
}
