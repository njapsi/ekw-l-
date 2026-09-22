/**
 * Content pattern detection over stored TikTok videos (Phase 7, mirroring
 * `youtube/patterns.ts`). Composes two deterministic checks — never a model
 * guess — and phrases every observation as a measured relationship, never a
 * causal claim.
 */
import { themeClusters, type TikTokVideoLike } from './metrics.js';
import { classifyDuration } from './benchmark.js';

export type TikTokPatternKind = 'HASHTAG_CLUSTER' | 'DURATION_SPLIT';

export interface TikTokContentPattern {
  kind: TikTokPatternKind;
  label: string;
  observation: string;
  evidence: string;
  videoIds: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function confidenceFor(sampleSize: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (sampleSize >= 10) return 'HIGH';
  if (sampleSize >= 5) return 'MEDIUM';
  return 'LOW';
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function n(v: bigint | null): number | null {
  return v == null ? null : Number(v);
}

/** Hashtag clusters whose average views exceed the account's own median. */
function hashtagPatterns(videos: TikTokVideoLike[]): TikTokContentPattern[] {
  const withViews = videos.filter((v) => v.viewCount != null).map((v) => n(v.viewCount)!);
  if (withViews.length === 0) return [];
  const accountMedian = median(withViews);

  return themeClusters(videos, 6)
    .filter((c) => c.totalViews / c.videoIds.length > accountMedian)
    .map((c) => ({
      kind: 'HASHTAG_CLUSTER' as const,
      label: `#${c.tag}`,
      observation: `Videos tagged #${c.tag} (${c.videoIds.length} video(s)) average ${Math.round(c.totalViews / c.videoIds.length).toLocaleString('en-US')} views, above this account's overall median of ${Math.round(accountMedian).toLocaleString('en-US')}.`,
      evidence: `${c.videoIds.length} video(s) tagged #${c.tag}, ${c.totalViews.toLocaleString('en-US')} total views.`,
      videoIds: c.videoIds,
      confidence: confidenceFor(c.videoIds.length),
    }));
}

/** Short (<=60s) vs. extended (>60s) split, when there's enough of each to compare. */
function durationPatterns(videos: TikTokVideoLike[]): TikTokContentPattern[] {
  const buckets = new Map<'short' | 'extended', TikTokVideoLike[]>();
  for (const v of videos) {
    const format = classifyDuration(v.durationSec);
    const arr = buckets.get(format) ?? [];
    arr.push(v);
    buckets.set(format, arr);
  }
  const short = (buckets.get('short') ?? []).filter((v) => v.viewCount != null);
  const extended = (buckets.get('extended') ?? []).filter((v) => v.viewCount != null);
  if (short.length < 5 || extended.length < 5) return [];

  const shortMedian = median(short.map((v) => n(v.viewCount)!));
  const extendedMedian = median(extended.map((v) => n(v.viewCount)!));
  if (shortMedian === 0 && extendedMedian === 0) return [];

  const higher = shortMedian >= extendedMedian ? 'short' : 'extended';
  const higherMedian = Math.max(shortMedian, extendedMedian);
  const lowerMedian = Math.min(shortMedian, extendedMedian);
  if (lowerMedian === 0 || higherMedian / lowerMedian < 1.2) return [];

  const winningVideos = higher === 'short' ? short : extended;
  return [
    {
      kind: 'DURATION_SPLIT',
      label: higher === 'short' ? 'Short-form (<=60s)' : 'Extended (>60s)',
      observation: `${higher === 'short' ? 'Short-form videos (<=60s)' : 'Extended videos (>60s)'} have a median of ${Math.round(higherMedian).toLocaleString('en-US')} views, vs. ${Math.round(lowerMedian).toLocaleString('en-US')} for the other duration bucket.`,
      evidence: `${short.length} short-form video(s) (median ${Math.round(shortMedian).toLocaleString('en-US')} views), ${extended.length} extended video(s) (median ${Math.round(extendedMedian).toLocaleString('en-US')} views).`,
      videoIds: winningVideos.map((v) => v.videoId),
      confidence: confidenceFor(Math.min(short.length, extended.length)),
    },
  ];
}

export function detectContentPatterns(videos: TikTokVideoLike[]): TikTokContentPattern[] {
  return [...hashtagPatterns(videos), ...durationPatterns(videos)];
}
