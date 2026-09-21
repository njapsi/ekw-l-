/**
 * Per-video performance benchmarking (Phase 6, Parts 14-16). Every video is
 * classified against its own channel's comparable history — never a global
 * YouTube average — using documented, fixed thresholds an LLM never invents
 * (Part 16: "Do not allow the LLM to invent thresholds").
 *
 * "Comparable" means: same format bucket (Short vs. long-form, split at the
 * conventional ≤180s Shorts duration threshold) among the channel's most
 * recent videos. Benchmarking against lifetime Data-API view/like/comment
 * counts (already reliably synced by `sync.ts`) rather than day-by-day
 * Analytics-API breakdowns per video is a deliberate scope choice — see
 * docs/YOUTUBE-GROWTH-AGENT.md §"What was deferred" for why per-video
 * Analytics sync was not attempted this phase.
 */
import { type Db, prisma } from '@growth-agent/db';
import type { VideoLike } from './metrics.js';
import { getPrimaryChannel } from './read.js';

export type VideoFormat = 'short' | 'long_form';

/** YouTube's own Shorts eligibility threshold at the time of writing. */
const SHORTS_MAX_SECONDS = 180;

export function classifyFormat(durationSeconds: number | null): VideoFormat {
  if (durationSeconds == null) return 'long_form';
  return durationSeconds <= SHORTS_MAX_SECONDS ? 'short' : 'long_form';
}

export type PerformanceClass =
  'OUTPERFORMING' | 'TYPICAL' | 'UNDERPERFORMING' | 'INSUFFICIENT_DATA';

export interface VideoBenchmark {
  videoId: string;
  title: string;
  format: VideoFormat;
  views: number;
  classification: PerformanceClass;
  /** views / peerMedianViews, or null when there weren't enough peers. */
  ratioToPeerMedian: number | null;
  peerMedianViews: number | null;
  peerCount: number;
}

/** Minimum comparable videos before a classification is meaningful — below
 *  this, `metrics.ts`'s `performerSplit` and this module both refuse to
 *  guess (Part 13: confidence depends on sample size). */
const MIN_PEERS = 5;
/** Documented thresholds (Part 16) — never derived from the data itself. */
const OUTPERFORM_RATIO = 1.5;
const UNDERPERFORM_RATIO = 0.5;

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Classify every video against the median of its own format bucket within
 * the same input set (the caller decides the comparison window — e.g. the
 * most recent N videos — Part 15: prioritize the creator's own history over
 * a global average).
 */
export function benchmarkVideos(videos: VideoLike[]): VideoBenchmark[] {
  const byFormat = new Map<VideoFormat, VideoLike[]>();
  for (const v of videos) {
    const fmt = classifyFormat(v.durationSeconds);
    const bucket = byFormat.get(fmt) ?? [];
    bucket.push(v);
    byFormat.set(fmt, bucket);
  }

  const medianByFormat = new Map<VideoFormat, { median: number; count: number }>();
  for (const [fmt, bucket] of byFormat) {
    const withViews = bucket.filter((v) => v.viewCount != null);
    if (withViews.length >= MIN_PEERS) {
      medianByFormat.set(fmt, {
        median: median(withViews.map((v) => Number(v.viewCount))),
        count: withViews.length,
      });
    }
  }

  return videos.map((v): VideoBenchmark => {
    const format = classifyFormat(v.durationSeconds);
    const views = v.viewCount == null ? 0 : Number(v.viewCount);
    const peer = medianByFormat.get(format);

    if (!peer || v.viewCount == null) {
      return {
        videoId: v.videoId,
        title: v.title,
        format,
        views,
        classification: 'INSUFFICIENT_DATA',
        ratioToPeerMedian: null,
        peerMedianViews: peer?.median ?? null,
        peerCount: peer?.count ?? 0,
      };
    }

    const ratio = peer.median > 0 ? views / peer.median : null;
    let classification: PerformanceClass = 'TYPICAL';
    if (ratio != null) {
      if (ratio >= OUTPERFORM_RATIO) classification = 'OUTPERFORMING';
      else if (ratio <= UNDERPERFORM_RATIO) classification = 'UNDERPERFORMING';
    }

    return {
      videoId: v.videoId,
      title: v.title,
      format,
      views,
      classification,
      ratioToPeerMedian: ratio,
      peerMedianViews: peer.median,
      peerCount: peer.count,
    };
  });
}

/** Compare a specific, bounded set of videos side by side (Part 15's
 *  "comparable videos" use case, exposed as `youtube.content.compare`). */
export function compareVideos(videos: VideoLike[]): VideoBenchmark[] {
  return benchmarkVideos(videos);
}

/**
 * The organization's primary channel's benchmarks over its most recently
 * published videos — the one read composition the `/app/youtube/performance`
 * UI page and the `youtube.content.performance` tool both need, kept in one
 * place rather than duplicated in each caller.
 */
export async function getRecentVideoBenchmarks(
  organizationId: string,
  limit = 50,
  db: Db = prisma,
): Promise<VideoBenchmark[]> {
  const channel = await getPrimaryChannel(organizationId, db);
  if (!channel) return [];
  const videos = await db.youTubeVideo.findMany({
    where: { youTubeChannelId: channel.id },
    orderBy: { publishedAt: 'desc' },
    take: limit,
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
  return benchmarkVideos(videos);
}
