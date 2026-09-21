/**
 * Content pattern detection (Phase 6, Parts 17-18). Composes existing pure
 * functions (`metrics.ts`'s `topicClusters`/`publishingCadence`, this
 * module's own `benchmark.ts`) into explicit, evidence-carrying pattern
 * observations — never a bare correlation claim, and never causation
 * (Part 17: "Do NOT claim causation unless evidence supports it" — nothing
 * here uses the word "causes"; every statement is phrased as an observed
 * relationship in the evidence data).
 */
import { classifyFormat, type VideoFormat } from './benchmark.js';
import { topicClusters, type VideoLike } from './metrics.js';

export type PatternKind = 'TOPIC_CLUSTER' | 'FORMAT_SPLIT' | 'PUBLISHING_CADENCE';

export interface ContentPattern {
  kind: PatternKind;
  label: string;
  observation: string;
  evidence: string;
  videoIds: string[];
  /** Sample size behind the observation — Part 13's confidence input. */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function confidenceFor(sampleSize: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (sampleSize >= 10) return 'HIGH';
  if (sampleSize >= 5) return 'MEDIUM';
  return 'LOW';
}

/** Median helper matching `benchmark.ts`'s own (kept local — this module
 *  must stay independently testable without importing a private helper). */
function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Topic-cluster patterns: which tag clusters have produced above-channel
 * -median views. Reuses `topicClusters` (tag co-occurrence, ≥2 shared-tag
 * videos) rather than a new clustering algorithm.
 */
function topicPatterns(videos: VideoLike[]): ContentPattern[] {
  const clusters = topicClusters(videos, 6);
  if (clusters.length === 0) return [];
  const allViews = videos.filter((v) => v.viewCount != null).map((v) => Number(v.viewCount));
  if (allViews.length < 5) return [];
  const channelMedian = median(allViews);

  return clusters
    .filter((c) => c.totalViews / c.videoIds.length > channelMedian)
    .map((c): ContentPattern => {
      const avgViews = Math.round(c.totalViews / c.videoIds.length);
      return {
        kind: 'TOPIC_CLUSTER',
        label: c.label,
        observation: `Videos tagged "${c.label}" have produced a higher average of views than the channel median over the videos analyzed.`,
        evidence: `${c.videoIds.length} video(s) tagged "${c.label}" averaged ${avgViews.toLocaleString('en-US')} views versus a channel median of ${Math.round(channelMedian).toLocaleString('en-US')} views.`,
        videoIds: c.videoIds,
        confidence: confidenceFor(c.videoIds.length),
      };
    });
}

/** Format-split pattern: does one format (Shorts vs. long-form) have a
 *  materially different median than the other? */
function formatPatterns(videos: VideoLike[]): ContentPattern[] {
  const byFormat = new Map<VideoFormat, VideoLike[]>();
  for (const v of videos) {
    const fmt = classifyFormat(v.durationSeconds);
    const bucket = byFormat.get(fmt) ?? [];
    bucket.push(v);
    byFormat.set(fmt, bucket);
  }
  const shorts = (byFormat.get('short') ?? []).filter((v) => v.viewCount != null);
  const longForm = (byFormat.get('long_form') ?? []).filter((v) => v.viewCount != null);
  if (shorts.length < 5 || longForm.length < 5) return [];

  const shortsMedian = median(shorts.map((v) => Number(v.viewCount)));
  const longFormMedian = median(longForm.map((v) => Number(v.viewCount)));
  if (shortsMedian === 0 && longFormMedian === 0) return [];

  const higher = shortsMedian >= longFormMedian ? 'Shorts' : 'long-form videos';
  const ratio =
    shortsMedian >= longFormMedian
      ? longFormMedian > 0
        ? shortsMedian / longFormMedian
        : null
      : shortsMedian > 0
        ? longFormMedian / shortsMedian
        : null;
  if (ratio == null || ratio < 1.2) return []; // not a meaningfully different split

  return [
    {
      kind: 'FORMAT_SPLIT',
      label: higher,
      observation: `${higher} have a higher median view count than the other format on this channel.`,
      evidence: `Shorts median: ${Math.round(shortsMedian).toLocaleString('en-US')} views (${shorts.length} videos). Long-form median: ${Math.round(longFormMedian).toLocaleString('en-US')} views (${longForm.length} videos).`,
      videoIds: (higher === 'Shorts' ? shorts : longForm).map((v) => v.videoId),
      confidence: confidenceFor(Math.min(shorts.length, longForm.length)),
    },
  ];
}

export function detectContentPatterns(videos: VideoLike[]): ContentPattern[] {
  return [...topicPatterns(videos), ...formatPatterns(videos)];
}
