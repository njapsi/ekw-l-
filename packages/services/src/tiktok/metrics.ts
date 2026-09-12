/**
 * Derived metrics over stored TikTok videos. TikTok's public API exposes no
 * day-by-day analytics, so everything here is computed from lifetime per-video
 * stats — each value is a `calculated_metric`, never invented. Fields the API
 * did not return are simply absent from the inputs.
 */
export interface TikTokVideoLike {
  videoId: string;
  caption: string | null;
  createTime: Date;
  durationSec: number | null;
  viewCount: bigint | null;
  likeCount: bigint | null;
  commentCount: bigint | null;
  shareCount: bigint | null;
  hashtags: string[];
}

const n = (v: bigint | null | undefined): number | null => (v == null ? null : Number(v));

export function engagementRate(v: TikTokVideoLike): number | null {
  const views = n(v.viewCount);
  if (!views) return null;
  return ((n(v.likeCount) ?? 0) + (n(v.commentCount) ?? 0) + (n(v.shareCount) ?? 0)) / views;
}

export interface CadenceSummary {
  postsPerWeek: number;
  medianGapDays: number | null;
  firstAt: Date | null;
  lastAt: Date | null;
}

export function postingCadence(videos: TikTokVideoLike[]): CadenceSummary {
  const dates = videos.map((v) => v.createTime).sort((a, b) => a.getTime() - b.getTime());
  if (dates.length < 2) {
    return {
      postsPerWeek: 0,
      medianGapDays: null,
      firstAt: dates[0] ?? null,
      lastAt: dates[dates.length - 1] ?? null,
    };
  }
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i]!.getTime() - dates[i - 1]!.getTime()) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const weeks = (dates[dates.length - 1]!.getTime() - dates[0]!.getTime()) / (7 * 86_400_000);
  return {
    postsPerWeek: weeks > 0 ? dates.length / weeks : 0,
    medianGapDays: gaps[Math.floor(gaps.length / 2)] ?? null,
    firstAt: dates[0]!,
    lastAt: dates[dates.length - 1]!,
  };
}

export interface PerformerSplit {
  high: TikTokVideoLike[];
  low: TikTokVideoLike[];
  median: number;
}

export function performerSplit(videos: TikTokVideoLike[]): PerformerSplit {
  const withViews = videos.filter((v) => v.viewCount != null);
  if (withViews.length < 5) return { high: [], low: [], median: 0 };
  const views = withViews.map((v) => n(v.viewCount)!).sort((a, b) => a - b);
  const mid = Math.floor(views.length / 2);
  const median = views.length % 2 ? views[mid]! : (views[mid - 1]! + views[mid]!) / 2;
  return {
    median,
    high: withViews.filter((v) => n(v.viewCount)! >= median * 1.5),
    low: withViews.filter((v) => n(v.viewCount)! <= median * 0.5),
  };
}

/** Group videos by shared hashtag, ranked by total views. */
export function themeClusters(
  videos: TikTokVideoLike[],
  maxClusters = 6,
): Array<{ tag: string; videoIds: string[]; totalViews: number }> {
  const map = new Map<string, { ids: Set<string>; views: number }>();
  for (const v of videos) {
    for (const raw of v.hashtags) {
      const tag = raw.trim().toLowerCase();
      if (tag.length < 2) continue;
      const e = map.get(tag) ?? { ids: new Set(), views: 0 };
      e.ids.add(v.videoId);
      e.views += n(v.viewCount) ?? 0;
      map.set(tag, e);
    }
  }
  return [...map.entries()]
    .filter(([, e]) => e.ids.size >= 2)
    .sort((a, b) => b[1].views - a[1].views)
    .slice(0, maxClusters)
    .map(([tag, e]) => ({ tag, videoIds: [...e.ids], totalViews: e.views }));
}
