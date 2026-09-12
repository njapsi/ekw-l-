import type { Db, OAuthConnection, TikTokAccount, TikTokSyncKind } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { ConnectionUnavailableError } from '../integrations/connections.js';
import { recordHealth } from '../integrations/health.js';
import { TT_SCOPE_STATS } from '../integrations/tiktok-oauth.js';
import type { TikTokClient } from './client.js';
import { extractHashtags } from './schemas.js';

const log = createLogger('tiktok.sync');

export interface TikTokSyncContext {
  db: Db;
  organizationId: string;
  connection: Pick<OAuthConnection, 'id' | 'scopes' | 'status'>;
}

export interface TikTokSyncResult {
  kind: TikTokSyncKind;
  itemsProcessed: number;
  skipped?: string;
}

function assertConnected(ctx: TikTokSyncContext): void {
  if (ctx.connection.status === 'REVOKED') {
    throw new ConnectionUnavailableError(
      'This TikTok account is disconnected. Reconnect it to sync.',
    );
  }
}

async function startRun(
  ctx: TikTokSyncContext,
  accountId: string,
  kind: TikTokSyncKind,
): Promise<string> {
  const run = await ctx.db.tikTokSyncRun.create({
    data: {
      organizationId: ctx.organizationId,
      tikTokAccountId: accountId,
      kind,
      status: 'RUNNING',
    },
  });
  return run.id;
}

async function finishRun(
  ctx: TikTokSyncContext,
  runId: string,
  r: { itemsProcessed: number; error?: string; cursor?: unknown; skipped?: boolean },
): Promise<void> {
  await ctx.db.tikTokSyncRun.update({
    where: { id: runId },
    data: {
      status: r.error ? 'FAILED' : r.skipped ? 'SKIPPED' : 'COMPLETED',
      itemsProcessed: r.itemsProcessed,
      error: r.error,
      cursor: r.cursor === undefined ? undefined : (r.cursor as never),
      finishedAt: new Date(),
    },
  });
  await recordHealth(ctx.connection.id, { ok: !r.error, detail: r.error ?? 'sync ok' }, ctx.db);
}

// --- 1. Account discovery / sync ------------------------------------------

const num = (v: number | null | undefined): bigint | null =>
  v == null ? null : BigInt(Math.round(v));

export async function discoverAccount(
  client: TikTokClient,
  ctx: TikTokSyncContext,
): Promise<TikTokAccount> {
  assertConnected(ctx);
  const { data } = await client.getUserInfo();
  const u = data.user;
  if (!u.open_id) {
    throw new Error('TikTok user/info returned no open_id — cannot identify the account.');
  }
  const hasStats = ctx.connection.scopes.includes(TT_SCOPE_STATS);

  const account = await ctx.db.tikTokAccount.upsert({
    where: { organizationId_openId: { organizationId: ctx.organizationId, openId: u.open_id } },
    update: {
      oauthConnectionId: ctx.connection.id,
      username: u.username ?? null,
      displayName: u.display_name ?? null,
      avatarUrl: u.avatar_url ?? null,
      bioDescription: u.bio_description ?? null,
      isVerified: u.is_verified ?? null,
      profileDeepLink: u.profile_deep_link ?? null,
      followerCount: hasStats ? num(u.follower_count) : null,
      followingCount: hasStats ? num(u.following_count) : null,
      likesCount: hasStats ? num(u.likes_count) : null,
      videoCountStat: hasStats && u.video_count != null ? u.video_count : null,
      lastSyncedAt: new Date(),
    },
    create: {
      organizationId: ctx.organizationId,
      oauthConnectionId: ctx.connection.id,
      openId: u.open_id,
      username: u.username ?? null,
      displayName: u.display_name ?? null,
      avatarUrl: u.avatar_url ?? null,
      bioDescription: u.bio_description ?? null,
      isVerified: u.is_verified ?? null,
      profileDeepLink: u.profile_deep_link ?? null,
      followerCount: hasStats ? num(u.follower_count) : null,
      followingCount: hasStats ? num(u.following_count) : null,
      likesCount: hasStats ? num(u.likes_count) : null,
      videoCountStat: hasStats && u.video_count != null ? u.video_count : null,
    },
  });

  if (hasStats) {
    await ctx.db.tikTokMetric.create({
      data: {
        organizationId: ctx.organizationId,
        tikTokAccountId: account.id,
        followerCount: num(u.follower_count),
        likesCount: num(u.likes_count),
        videoCount: u.video_count ?? null,
      },
    });
  }

  await ctx.db.oAuthConnection.update({
    where: { id: ctx.connection.id },
    data: { displayName: account.displayName ?? account.username ?? undefined },
  });
  log.info({ organizationId: ctx.organizationId, accountId: account.id }, 'tiktok account synced');
  return account;
}

export async function syncAccount(
  client: TikTokClient,
  ctx: TikTokSyncContext,
  account: TikTokAccount,
): Promise<TikTokSyncResult> {
  assertConnected(ctx);
  const runId = await startRun(ctx, account.id, 'ACCOUNT');
  try {
    await discoverAccount(client, ctx);
    await finishRun(ctx, runId, { itemsProcessed: 1 });
    return { kind: 'ACCOUNT', itemsProcessed: 1 };
  } catch (err) {
    await finishRun(ctx, runId, {
      itemsProcessed: 0,
      error: err instanceof Error ? err.message : 'account sync failed',
    });
    throw err;
  }
}

// --- 2. Video synchronization (incremental) ------------------------------

export interface VideoSyncOptions {
  maxNewVideos?: number;
  refreshRecentCount?: number;
}

export async function syncVideos(
  client: TikTokClient,
  ctx: TikTokSyncContext,
  account: TikTokAccount,
  opts: VideoSyncOptions = {},
): Promise<TikTokSyncResult> {
  assertConnected(ctx);
  if (!ctx.connection.scopes.includes('video.list')) {
    return { kind: 'VIDEOS', itemsProcessed: 0, skipped: 'video.list scope not granted' };
  }
  const maxNew = opts.maxNewVideos ?? 200;
  const runId = await startRun(ctx, account.id, 'VIDEOS');

  try {
    const cursorSec = account.lastVideoCreateTime
      ? Math.floor(account.lastVideoCreateTime.getTime() / 1000)
      : undefined;
    let cursor: number | undefined;
    let processed = 0;
    let skippedMissingCreateTime = 0;
    let latestCreate = account.lastVideoCreateTime ?? null;
    let stop = false;

    for (let page = 0; page < 25 && !stop; page++) {
      const { data } = await client.listVideos(cursor, 20);
      if (data.videos.length === 0) break;

      for (const v of data.videos) {
        if (cursorSec && v.create_time && v.create_time <= cursorSec) {
          stop = true;
          break;
        }
        if (v.create_time == null) {
          // `createTime` is a required, non-null column and feeds cadence/gap
          // math and sort order — a fabricated epoch date (1970-01-01) would
          // corrupt both. TikTok always returns create_time for real videos;
          // treat its absence as a malformed row and skip it rather than
          // inventing a date, same as "nothing partial/corrupted is written"
          // elsewhere in this sync engine.
          skippedMissingCreateTime++;
          log.warn(
            { organizationId: ctx.organizationId, videoId: v.id },
            'tiktok video missing create_time; skipped rather than dating it 1970-01-01',
          );
          continue;
        }
        const createTime = new Date(v.create_time * 1000);
        const caption = v.video_description ?? v.title ?? null;
        await ctx.db.tikTokVideo.upsert({
          where: { organizationId_videoId: { organizationId: ctx.organizationId, videoId: v.id } },
          update: {
            caption,
            createTime,
            durationSec: v.duration ?? null,
            coverImageUrl: v.cover_image_url ?? null,
            shareUrl: v.share_url ?? null,
            embedLink: v.embed_link ?? null,
            hashtags: extractHashtags(caption ?? undefined),
            viewCount: num(v.view_count),
            likeCount: num(v.like_count),
            commentCount: num(v.comment_count),
            shareCount: num(v.share_count),
            statsUpdatedAt: new Date(),
            lastSyncedAt: new Date(),
          },
          create: {
            organizationId: ctx.organizationId,
            tikTokAccountId: account.id,
            videoId: v.id,
            caption,
            createTime,
            durationSec: v.duration ?? null,
            coverImageUrl: v.cover_image_url ?? null,
            shareUrl: v.share_url ?? null,
            embedLink: v.embed_link ?? null,
            hashtags: extractHashtags(caption ?? undefined),
            viewCount: num(v.view_count),
            likeCount: num(v.like_count),
            commentCount: num(v.comment_count),
            shareCount: num(v.share_count),
            statsUpdatedAt: new Date(),
          },
        });
        processed++;
        if (!latestCreate || createTime > latestCreate) latestCreate = createTime;
        if (processed >= maxNew) {
          stop = true;
          break;
        }
      }

      if (!data.has_more || data.cursor == null) break;
      cursor = data.cursor;
    }

    await ctx.db.tikTokAccount.update({
      where: { id: account.id },
      data: {
        lastVideoSyncAt: new Date(),
        lastVideoCreateTime: latestCreate ?? account.lastVideoCreateTime,
      },
    });
    await finishRun(ctx, runId, {
      itemsProcessed: processed,
      cursor: {
        lastVideoCreateTime: latestCreate?.toISOString() ?? null,
        skippedMissingCreateTime,
      },
      skipped: processed === 0,
    });
    return {
      kind: 'VIDEOS',
      itemsProcessed: processed,
      skipped:
        processed === 0
          ? 'no new videos returned by the API'
          : skippedMissingCreateTime > 0
            ? `${skippedMissingCreateTime} video(s) skipped: missing create_time`
            : undefined,
    };
  } catch (err) {
    await finishRun(ctx, runId, {
      itemsProcessed: 0,
      error: err instanceof Error ? err.message : 'video sync failed',
    });
    throw err;
  }
}

export async function runFullSync(
  client: TikTokClient,
  ctx: TikTokSyncContext,
): Promise<TikTokSyncResult[]> {
  const account = await discoverAccount(client, ctx);
  return [{ kind: 'ACCOUNT' as const, itemsProcessed: 1 }, await syncVideos(client, ctx, account)];
}
