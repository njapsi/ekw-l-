/**
 * Per-video performance benchmarking (Phase 7, mirroring
 * `youtube/benchmark.ts`). Every video is classified against its own
 * account's comparable history — never a global TikTok average — using
 * documented, fixed thresholds an LLM never invents.
 *
 * "Comparable" means: same duration bucket (short ≤60s vs. extended >60s,
 * the conventional TikTok short-form cutoff — TikTok now supports videos up
 * to several minutes long, so a duration split is a real, meaningful axis
 * here, not an invented one) among the account's most recent videos.
 * Benchmarking uses lifetime per-video counts (already reliably synced by
 * `sync.ts`) — TikTok's Display API exposes no day-by-day breakdown at all,
 * so there is no richer time-series to benchmark against (see
 * `docs/TIKTOK-GROWTH-AGENT.md`).
 */
import { type Db, prisma } from '@growth-agent/db';
import type { TikTokVideoLike } from './metrics.js';
import { getPrimaryAccount } from './read.js';

export type TikTokVideoFormat = 'short' | 'extended';

/** TikTok's conventional short-form cutoff at the time of writing. */
const SHORT_MAX_SECONDS = 60;

export function classifyDuration(durationSec: number | null): TikTokVideoFormat {
  if (durationSec == null) return 'short';
  return durationSec <= SHORT_MAX_SECONDS ? 'short' : 'extended';
}

export type TikTokPerformanceClass =
  'OUTPERFORMING' | 'TYPICAL' | 'UNDERPERFORMING' | 'INSUFFICIENT_DATA';

export interface TikTokVideoBenchmark {
  videoId: string;
  caption: string | null;
  format: TikTokVideoFormat;
  views: number;
  classification: TikTokPerformanceClass;
  /** views / peerMedianViews, or null when there weren't enough peers. */
  ratioToPeerMedian: number | null;
  peerMedianViews: number | null;
  peerCount: number;
}

/** Minimum comparable videos before a classification is meaningful — below
 *  this, `metrics.ts`'s `performerSplit` and this module both refuse to
 *  guess, matching the YouTube benchmark module's convention exactly. */
const MIN_PEERS = 5;
/** Documented thresholds — never derived from the data itself. */
const OUTPERFORM_RATIO = 1.5;
const UNDERPERFORM_RATIO = 0.5;

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Classify every video against the median of its own duration bucket within
 * the same input set (the caller decides the comparison window, e.g. the
 * most recent N videos).
 */
export function benchmarkVideos(videos: TikTokVideoLike[]): TikTokVideoBenchmark[] {
  const byFormat = new Map<TikTokVideoFormat, number[]>();
  for (const v of videos) {
    if (v.viewCount == null) continue;
    const format = classifyDuration(v.durationSec);
    const arr = byFormat.get(format) ?? [];
    arr.push(Number(v.viewCount));
    byFormat.set(format, arr);
  }

  return videos.map((v) => {
    const format = classifyDuration(v.durationSec);
    const peers = byFormat.get(format) ?? [];
    const views = v.viewCount == null ? null : Number(v.viewCount);

    if (views == null || peers.length < MIN_PEERS) {
      return {
        videoId: v.videoId,
        caption: v.caption,
        format,
        views: views ?? 0,
        classification: 'INSUFFICIENT_DATA',
        ratioToPeerMedian: null,
        peerMedianViews: null,
        peerCount: peers.length,
      };
    }

    const peerMedian = median(peers);
    const ratio = peerMedian > 0 ? views / peerMedian : null;
    let classification: TikTokPerformanceClass = 'TYPICAL';
    if (ratio != null) {
      if (ratio >= OUTPERFORM_RATIO) classification = 'OUTPERFORMING';
      else if (ratio <= UNDERPERFORM_RATIO) classification = 'UNDERPERFORMING';
    }

    return {
      videoId: v.videoId,
      caption: v.caption,
      format,
      views,
      classification,
      ratioToPeerMedian: ratio,
      peerMedianViews: peerMedian,
      peerCount: peers.length,
    };
  });
}

/** Compare a specific, bounded set of videos side by side. */
export function compareVideos(videos: TikTokVideoLike[]): TikTokVideoBenchmark[] {
  return benchmarkVideos(videos);
}

/**
 * The organization's primary account's benchmarks over its most recently
 * published videos — the one read composition the `/app/tiktok/performance`
 * UI page and the `tiktok.content.performance` tool both need.
 */
export async function getRecentVideoBenchmarks(
  organizationId: string,
  limit = 50,
  db: Db = prisma,
): Promise<TikTokVideoBenchmark[]> {
  const account = await getPrimaryAccount(organizationId, db);
  if (!account) return [];
  const videos = await db.tikTokVideo.findMany({
    where: { tikTokAccountId: account.id },
    orderBy: { createTime: 'desc' },
    take: limit,
    select: {
      videoId: true,
      caption: true,
      createTime: true,
      durationSec: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      shareCount: true,
      hashtags: true,
    },
  });
  return benchmarkVideos(videos);
}
