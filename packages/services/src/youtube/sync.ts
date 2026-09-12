import {
  type Db,
  type OAuthConnection,
  type YouTubeChannel,
  type YouTubeSyncKind,
  prisma,
} from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { ConnectionUnavailableError } from '../integrations/connections.js';
import { addQuotaUsage, recordHealth } from '../integrations/health.js';
import { YT_SCOPE_ANALYTICS_MONETARY } from '../integrations/google.js';
import { MalformedApiDataError, type YouTubeClient } from './client.js';
import { assertQuota } from './quota.js';
import { parseBigIntish, parseIsoDuration } from './schemas.js';

const log = createLogger('youtube.sync');

export interface SyncContext {
  db: Db;
  organizationId: string;
  connection: Pick<OAuthConnection, 'id' | 'scopes' | 'status'>;
}

export interface SyncResult {
  kind: YouTubeSyncKind;
  itemsProcessed: number;
  quotaUnitsSpent: number;
  skipped?: string;
}

function assertConnected(ctx: SyncContext): void {
  if (ctx.connection.status === 'REVOKED') {
    throw new ConnectionUnavailableError(
      'This YouTube account is disconnected. Reconnect it to sync.',
    );
  }
}

async function startRun(
  ctx: SyncContext,
  channelId: string,
  kind: YouTubeSyncKind,
): Promise<string> {
  const run = await ctx.db.youTubeSyncRun.create({
    data: {
      organizationId: ctx.organizationId,
      youTubeChannelId: channelId,
      kind,
      status: 'RUNNING',
    },
  });
  return run.id;
}

async function finishRun(
  ctx: SyncContext,
  runId: string,
  result: {
    itemsProcessed: number;
    quotaUnitsSpent: number;
    error?: string;
    cursor?: unknown;
    skipped?: boolean;
  },
): Promise<void> {
  await ctx.db.youTubeSyncRun.update({
    where: { id: runId },
    data: {
      status: result.error ? 'FAILED' : result.skipped ? 'SKIPPED' : 'COMPLETED',
      itemsProcessed: result.itemsProcessed,
      quotaUnitsSpent: result.quotaUnitsSpent,
      error: result.error,
      cursor: result.cursor === undefined ? undefined : (result.cursor as never),
      finishedAt: new Date(),
    },
  });
  if (result.quotaUnitsSpent > 0) {
    await addQuotaUsage(ctx.connection.id, result.quotaUnitsSpent, ctx.db);
  }
  await recordHealth(
    ctx.connection.id,
    { ok: !result.error, detail: result.error ?? 'sync ok' },
    ctx.db,
  );
}

// --- 1. Channel discovery -------------------------------------------------

export async function discoverChannels(
  client: YouTubeClient,
  ctx: SyncContext,
): Promise<YouTubeChannel[]> {
  assertConnected(ctx);
  await assertQuota(ctx.connection.id, 1, ctx.db);
  const { data, quotaUnits } = await client.listMyChannels();

  const channels: YouTubeChannel[] = [];
  for (const item of data.items) {
    const stats = item.statistics;
    const snippet = item.snippet;
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;
    const row = await ctx.db.youTubeChannel.upsert({
      where: {
        organizationId_channelId: { organizationId: ctx.organizationId, channelId: item.id },
      },
      update: {
        oauthConnectionId: ctx.connection.id,
        title: snippet.title ?? '(untitled)',
        handle: snippet.customUrl ?? null,
        description: snippet.description ?? null,
        thumbnailUrl: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.medium?.url ?? null,
        country: snippet.country ?? null,
        publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
        uploadsPlaylistId: uploads ?? null,
        subscriberCount: parseBigIntish(stats.subscriberCount),
        hiddenSubscriberCount: stats.hiddenSubscriberCount ?? false,
        videoCount: stats.videoCount ? Number(stats.videoCount) : null,
        viewCount: parseBigIntish(stats.viewCount),
        lastSyncedAt: new Date(),
      },
      create: {
        organizationId: ctx.organizationId,
        oauthConnectionId: ctx.connection.id,
        channelId: item.id,
        title: snippet.title ?? '(untitled)',
        handle: snippet.customUrl ?? null,
        description: snippet.description ?? null,
        thumbnailUrl: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.medium?.url ?? null,
        country: snippet.country ?? null,
        publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
        uploadsPlaylistId: uploads ?? null,
        subscriberCount: parseBigIntish(stats.subscriberCount),
        hiddenSubscriberCount: stats.hiddenSubscriberCount ?? false,
        videoCount: stats.videoCount ? Number(stats.videoCount) : null,
        viewCount: parseBigIntish(stats.viewCount),
      },
    });
    channels.push(row);
  }

  await addQuotaUsage(ctx.connection.id, quotaUnits, ctx.db);
  await ctx.db.oAuthConnection.update({
    where: { id: ctx.connection.id },
    data: { displayName: channels[0]?.title ?? undefined },
  });
  log.info({ organizationId: ctx.organizationId, count: channels.length }, 'discovered channels');
  return channels;
}

// --- 2. Channel stats refresh ------------------------------------------------

export async function syncChannel(
  client: YouTubeClient,
  ctx: SyncContext,
  channel: YouTubeChannel,
): Promise<SyncResult> {
  assertConnected(ctx);
  const runId = await startRun(ctx, channel.id, 'CHANNEL');
  try {
    await assertQuota(ctx.connection.id, 1, ctx.db);
    const { data, quotaUnits } = await client.getChannels([channel.channelId]);
    const item = data.items[0];
    if (!item) {
      await finishRun(ctx, runId, {
        itemsProcessed: 0,
        quotaUnitsSpent: quotaUnits,
        skipped: true,
      });
      return {
        kind: 'CHANNEL',
        itemsProcessed: 0,
        quotaUnitsSpent: quotaUnits,
        skipped: 'channel not returned',
      };
    }
    const stats = item.statistics;
    await ctx.db.youTubeChannel.update({
      where: { id: channel.id },
      data: {
        title: item.snippet?.title ?? channel.title,
        subscriberCount: parseBigIntish(stats.subscriberCount),
        hiddenSubscriberCount: stats.hiddenSubscriberCount ?? false,
        videoCount: stats.videoCount ? Number(stats.videoCount) : channel.videoCount,
        viewCount: parseBigIntish(stats.viewCount),
        lastSyncedAt: new Date(),
      },
    });
    await finishRun(ctx, runId, { itemsProcessed: 1, quotaUnitsSpent: quotaUnits });
    return { kind: 'CHANNEL', itemsProcessed: 1, quotaUnitsSpent: quotaUnits };
  } catch (err) {
    await finishRun(ctx, runId, {
      itemsProcessed: 0,
      quotaUnitsSpent: 0,
      error: err instanceof Error ? err.message : 'sync failed',
    });
    throw err;
  }
}

// --- 3. Video synchronization (incremental) --------------------------------

export interface VideoSyncOptions {
  /** Hard cap on new videos fetched in one run. */
  maxNewVideos?: number;
  /** Also refresh lifetime stats for the N most recent stored videos. */
  refreshRecentCount?: number;
}

export async function syncVideos(
  client: YouTubeClient,
  ctx: SyncContext,
  channel: YouTubeChannel,
  opts: VideoSyncOptions = {},
): Promise<SyncResult> {
  assertConnected(ctx);
  const maxNew = opts.maxNewVideos ?? 200;
  const refreshRecent = opts.refreshRecentCount ?? 30;
  const runId = await startRun(ctx, channel.id, 'VIDEOS');
  let quotaSpent = 0;

  try {
    if (!channel.uploadsPlaylistId) {
      await finishRun(ctx, runId, { itemsProcessed: 0, quotaUnitsSpent: 0, skipped: true });
      return {
        kind: 'VIDEOS',
        itemsProcessed: 0,
        quotaUnitsSpent: 0,
        skipped: 'no uploads playlist',
      };
    }

    const cursorIso = channel.lastVideoPublishedAt?.toISOString() ?? null;
    const newIds: string[] = [];
    let latestSeen = channel.lastVideoPublishedAt ?? null;
    let pageToken: string | undefined;

    // Walk the uploads playlist newest-first, stopping at the cursor.
    for (let page = 0; page < 40; page++) {
      await assertQuota(ctx.connection.id, 1, ctx.db);
      const { data, quotaUnits } = await client.listPlaylistItems(
        channel.uploadsPlaylistId,
        pageToken,
      );
      quotaSpent += quotaUnits;
      let reachedCursor = false;
      for (const it of data.items) {
        const vid = it.contentDetails?.videoId;
        const pub = it.contentDetails?.videoPublishedAt;
        if (!vid) continue;
        if (cursorIso && pub && pub <= cursorIso) {
          reachedCursor = true;
          break;
        }
        newIds.push(vid);
        if (pub) {
          const d = new Date(pub);
          if (!latestSeen || d > latestSeen) latestSeen = d;
        }
        if (newIds.length >= maxNew) break;
      }
      pageToken = data.nextPageToken;
      if (reachedCursor || newIds.length >= maxNew || !pageToken) break;
    }

    // Recent stored videos whose lifetime stats we also refresh.
    const recentStored = await ctx.db.youTubeVideo.findMany({
      where: { youTubeChannelId: channel.id },
      orderBy: { publishedAt: 'desc' },
      take: refreshRecent,
      select: { videoId: true },
    });
    const toFetch = Array.from(new Set([...newIds, ...recentStored.map((v) => v.videoId)]));

    let processed = 0;
    for (let i = 0; i < toFetch.length; i += 50) {
      const batch = toFetch.slice(i, i + 50);
      await assertQuota(ctx.connection.id, 1, ctx.db);
      const { data, quotaUnits } = await client.getVideos(batch);
      quotaSpent += quotaUnits;
      for (const v of data.items) {
        const s = v.snippet;
        const stats = v.statistics;
        const publishedAt = s.publishedAt ? new Date(s.publishedAt) : new Date();
        await ctx.db.youTubeVideo.upsert({
          where: { organizationId_videoId: { organizationId: ctx.organizationId, videoId: v.id } },
          update: {
            title: s.title ?? '(untitled)',
            description: s.description ?? null,
            publishedAt,
            durationSeconds: parseIsoDuration(v.contentDetails?.duration) ?? undefined,
            tags: s.tags ?? [],
            categoryId: s.categoryId ?? null,
            thumbnailUrl: s.thumbnails?.high?.url ?? s.thumbnails?.medium?.url ?? null,
            privacyStatus: v.status?.privacyStatus ?? null,
            madeForKids: v.status?.madeForKids ?? null,
            liveBroadcastContent: s.liveBroadcastContent ?? null,
            defaultLanguage: s.defaultLanguage ?? null,
            viewCount: parseBigIntish(stats.viewCount),
            likeCount: parseBigIntish(stats.likeCount),
            commentCount: parseBigIntish(stats.commentCount),
            favoriteCount: parseBigIntish(stats.favoriteCount),
            statsUpdatedAt: new Date(),
            lastSyncedAt: new Date(),
          },
          create: {
            organizationId: ctx.organizationId,
            youTubeChannelId: channel.id,
            videoId: v.id,
            title: s.title ?? '(untitled)',
            description: s.description ?? null,
            publishedAt,
            durationSeconds: parseIsoDuration(v.contentDetails?.duration),
            tags: s.tags ?? [],
            categoryId: s.categoryId ?? null,
            thumbnailUrl: s.thumbnails?.high?.url ?? s.thumbnails?.medium?.url ?? null,
            privacyStatus: v.status?.privacyStatus ?? null,
            madeForKids: v.status?.madeForKids ?? null,
            liveBroadcastContent: s.liveBroadcastContent ?? null,
            defaultLanguage: s.defaultLanguage ?? null,
            viewCount: parseBigIntish(stats.viewCount),
            likeCount: parseBigIntish(stats.likeCount),
            commentCount: parseBigIntish(stats.commentCount),
            favoriteCount: parseBigIntish(stats.favoriteCount),
            statsUpdatedAt: new Date(),
          },
        });
        processed++;
      }
    }

    await ctx.db.youTubeChannel.update({
      where: { id: channel.id },
      data: {
        lastVideoSyncAt: new Date(),
        lastVideoPublishedAt: latestSeen ?? channel.lastVideoPublishedAt,
      },
    });

    await finishRun(ctx, runId, {
      itemsProcessed: processed,
      quotaUnitsSpent: quotaSpent,
      cursor: { lastVideoPublishedAt: latestSeen?.toISOString() ?? null, newVideos: newIds.length },
    });
    return { kind: 'VIDEOS', itemsProcessed: processed, quotaUnitsSpent: quotaSpent };
  } catch (err) {
    await finishRun(ctx, runId, {
      itemsProcessed: 0,
      quotaUnitsSpent: quotaSpent,
      error: err instanceof Error ? err.message : 'video sync failed',
    });
    throw err;
  }
}

// --- 4. Analytics synchronization (incremental by date) --------------------

const CHANNEL_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'likes',
  'comments',
  'shares',
  'subscribersGained',
  'subscribersLost',
];

export interface AnalyticsSyncOptions {
  /** How many days back to seed on the first run. */
  seedDays?: number;
  /** Reference "today" (for tests). */
  now?: Date;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function syncAnalytics(
  client: YouTubeClient,
  ctx: SyncContext,
  channel: YouTubeChannel,
  opts: AnalyticsSyncOptions = {},
): Promise<SyncResult> {
  assertConnected(ctx);
  const now = opts.now ?? new Date();
  const seedDays = opts.seedDays ?? 90;
  const runId = await startRun(ctx, channel.id, 'ANALYTICS');
  let quotaSpent = 0;

  try {
    // Analytics has a reporting lag; never ask for the last 2 days.
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() - 2);

    const start = new Date(end);
    if (channel.lastAnalyticsSyncAt) {
      // 3-day overlap so late-arriving data is corrected.
      start.setTime(channel.lastAnalyticsSyncAt.getTime());
      start.setUTCDate(start.getUTCDate() - 3);
    } else {
      start.setUTCDate(end.getUTCDate() - seedDays);
    }
    if (start > end) {
      await finishRun(ctx, runId, { itemsProcessed: 0, quotaUnitsSpent: 0, skipped: true });
      return {
        kind: 'ANALYTICS',
        itemsProcessed: 0,
        quotaUnitsSpent: 0,
        skipped: 'nothing new to fetch',
      };
    }

    const wantsRevenue = ctx.connection.scopes.includes(YT_SCOPE_ANALYTICS_MONETARY);
    const metrics = wantsRevenue ? [...CHANNEL_METRICS, 'estimatedRevenue'] : CHANNEL_METRICS;

    await assertQuota(ctx.connection.id, 1, ctx.db);
    const { data, quotaUnits } = await client.queryAnalytics({
      ids: `channel==${channel.channelId}`,
      startDate: ymd(start),
      endDate: ymd(end),
      metrics,
      dimensions: ['day'],
      sort: 'day',
      maxResults: 400,
    });
    quotaSpent += quotaUnits;

    const cols = data.columnHeaders.map((c) => c.name);
    const idx = (name: string) => cols.indexOf(name);
    const rows = data.rows ?? [];

    // A column we explicitly requested (`CHANNEL_METRICS`) missing from an
    // otherwise-successful response is malformed data, not a legitimate
    // zero — writing 0 for every row would be indistinguishable from a real
    // zero-views/likes/etc. day. `estimatedRevenue` is excluded: its absence
    // is legitimate (a non-monetized channel has no revenue column even when
    // requested) and is already handled below via `revI`/`revenue`.
    const missingCols = CHANNEL_METRICS.filter((m) => idx(m) === -1);
    if (missingCols.length > 0) {
      throw new MalformedApiDataError('youtubeAnalytics.reports.query', {
        requested: metrics,
        missingColumns: missingCols,
        received: cols,
      });
    }

    let processed = 0;
    for (const row of rows) {
      const date = String(row[idx('day')] ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const num = (name: string): number => {
        const i = idx(name);
        const v = i >= 0 ? row[i] : undefined;
        return typeof v === 'number' ? v : v ? Number(v) : 0;
      };
      const revI = idx('estimatedRevenue');
      const revenue = revI >= 0 && row[revI] !== undefined ? Number(row[revI]) : null;
      const avgDur = num('averageViewDuration');

      await ctx.db.youTubeMetric.upsert({
        where: {
          subjectType_subjectId_date: {
            subjectType: 'CHANNEL',
            subjectId: channel.channelId,
            date: new Date(date),
          },
        },
        update: {
          views: BigInt(Math.round(num('views'))),
          estimatedMinutesWatched: BigInt(Math.round(num('estimatedMinutesWatched'))),
          averageViewDurationSec: avgDur ? Math.round(avgDur) : null,
          likes: BigInt(Math.round(num('likes'))),
          comments: BigInt(Math.round(num('comments'))),
          shares: BigInt(Math.round(num('shares'))),
          subscribersGained: BigInt(Math.round(num('subscribersGained'))),
          subscribersLost: BigInt(Math.round(num('subscribersLost'))),
          estimatedRevenue: revenue,
        },
        create: {
          organizationId: ctx.organizationId,
          subjectType: 'CHANNEL',
          subjectId: channel.channelId,
          date: new Date(date),
          views: BigInt(Math.round(num('views'))),
          estimatedMinutesWatched: BigInt(Math.round(num('estimatedMinutesWatched'))),
          averageViewDurationSec: avgDur ? Math.round(avgDur) : null,
          likes: BigInt(Math.round(num('likes'))),
          comments: BigInt(Math.round(num('comments'))),
          shares: BigInt(Math.round(num('shares'))),
          subscribersGained: BigInt(Math.round(num('subscribersGained'))),
          subscribersLost: BigInt(Math.round(num('subscribersLost'))),
          estimatedRevenue: revenue,
        },
      });
      processed++;
    }

    await ctx.db.youTubeChannel.update({
      where: { id: channel.id },
      data: { lastAnalyticsSyncAt: end },
    });

    await finishRun(ctx, runId, {
      itemsProcessed: processed,
      quotaUnitsSpent: quotaSpent,
      cursor: { start: ymd(start), end: ymd(end), rows: rows.length },
      skipped: processed === 0,
    });
    return {
      kind: 'ANALYTICS',
      itemsProcessed: processed,
      quotaUnitsSpent: quotaSpent,
      skipped:
        processed === 0
          ? 'no analytics rows returned (data may be unavailable for this range)'
          : undefined,
    };
  } catch (err) {
    await finishRun(ctx, runId, {
      itemsProcessed: 0,
      quotaUnitsSpent: quotaSpent,
      error: err instanceof Error ? err.message : 'analytics sync failed',
    });
    throw err;
  }
}

// --- Orchestration -------------------------------------------------------

export async function runFullSync(client: YouTubeClient, ctx: SyncContext): Promise<SyncResult[]> {
  const channels = await discoverChannels(client, ctx);
  const results: SyncResult[] = [];
  for (const channel of channels) {
    results.push(await syncChannel(client, ctx, channel));
    results.push(await syncVideos(client, ctx, channel));
    results.push(await syncAnalytics(client, ctx, channel));
  }
  return results;
}

/** Convenience for callers that only have ids. */
export async function syncContextFor(
  organizationId: string,
  connectionId: string,
  db: Db = prisma,
): Promise<SyncContext> {
  const connection = await db.oAuthConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, scopes: true, status: true, organizationId: true },
  });
  if (!connection || connection.organizationId !== organizationId) {
    throw new Error('connection not found for organization');
  }
  return { db, organizationId, connection };
}
