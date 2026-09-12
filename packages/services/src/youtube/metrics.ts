/**
 * Derived metrics over stored YouTube data. Every value here is a
 * `calculated_metric` — computed from figures the API returned, never invented.
 * The functions are pure so they are trivially testable and reusable by the
 * dashboard and the analyst agent.
 */

export interface VideoLike {
  videoId: string;
  title: string;
  publishedAt: Date;
  durationSeconds: number | null;
  viewCount: bigint | null;
  likeCount: bigint | null;
  commentCount: bigint | null;
  tags: string[];
}

export interface DailyMetricLike {
  date: Date;
  views: bigint;
  estimatedMinutesWatched: bigint;
  likes: bigint;
  comments: bigint;
  shares: bigint;
  subscribersGained: bigint;
  subscribersLost: bigint;
  estimatedRevenue: number | null;
}

const n = (v: bigint | null | undefined): number => (v == null ? 0 : Number(v));

/** likes + comments as a fraction of views. null when views are unknown/zero. */
export function engagementRate(v: VideoLike): number | null {
  const views = n(v.viewCount);
  if (!views) return null;
  return (n(v.likeCount) + n(v.commentCount)) / views;
}

export interface PerformerSplit {
  high: VideoLike[];
  low: VideoLike[];
  median: number;
  mean: number;
}

/**
 * Classify videos by views using a robust z-like split around the median.
 * "high" = ≥ 1.5× median, "low" = ≤ 0.5× median (and below mean). Needs ≥ 5
 * videos to be meaningful; returns empty splits otherwise.
 */
export function performerSplit(videos: VideoLike[]): PerformerSplit {
  const withViews = videos.filter((v) => v.viewCount != null);
  if (withViews.length < 5) {
    return { high: [], low: [], median: 0, mean: 0 };
  }
  const views = withViews.map((v) => n(v.viewCount)).sort((a, b) => a - b);
  const mid = Math.floor(views.length / 2);
  const median = views.length % 2 ? views[mid]! : (views[mid - 1]! + views[mid]!) / 2;
  const mean = views.reduce((s, x) => s + x, 0) / views.length;
  return {
    median,
    mean,
    high: withViews.filter((v) => n(v.viewCount) >= median * 1.5),
    low: withViews.filter((v) => n(v.viewCount) <= median * 0.5 && n(v.viewCount) < mean),
  };
}

export interface PublishingCadence {
  videosPerWeek: number;
  medianGapDays: number | null;
  longestGapDays: number | null;
  firstPublishedAt: Date | null;
  lastPublishedAt: Date | null;
}

export function publishingCadence(videos: VideoLike[]): PublishingCadence {
  const dates = videos
    .map((v) => v.publishedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length < 2) {
    return {
      videosPerWeek: 0,
      medianGapDays: null,
      longestGapDays: null,
      firstPublishedAt: dates[0] ?? null,
      lastPublishedAt: dates[dates.length - 1] ?? null,
    };
  }
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i]!.getTime() - dates[i - 1]!.getTime()) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const spanWeeks = (dates[dates.length - 1]!.getTime() - dates[0]!.getTime()) / (7 * 86_400_000);
  return {
    videosPerWeek: spanWeeks > 0 ? dates.length / spanWeeks : 0,
    medianGapDays: gaps[Math.floor(gaps.length / 2)] ?? null,
    longestGapDays: gaps[gaps.length - 1] ?? null,
    firstPublishedAt: dates[0]!,
    lastPublishedAt: dates[dates.length - 1]!,
  };
}

export interface WindowTotals {
  days: number;
  views: number;
  minutesWatched: number;
  watchHours: number;
  netSubscribers: number;
  subscribersGained: number;
  subscribersLost: number;
  estimatedRevenue: number | null;
  hasRevenue: boolean;
}

/** Sum a trailing window of daily metrics. Missing days simply aren't counted. */
export function windowTotals(
  daily: DailyMetricLike[],
  days: number,
  now = new Date(),
): WindowTotals {
  const cutoff = now.getTime() - days * 86_400_000;
  const rows = daily.filter((d) => d.date.getTime() >= cutoff);
  let views = 0,
    minutes = 0,
    gained = 0,
    lost = 0,
    revenue = 0,
    hasRevenue = false;
  for (const r of rows) {
    views += n(r.views);
    minutes += n(r.estimatedMinutesWatched);
    gained += n(r.subscribersGained);
    lost += n(r.subscribersLost);
    if (r.estimatedRevenue != null) {
      revenue += r.estimatedRevenue;
      hasRevenue = true;
    }
  }
  return {
    days,
    views,
    minutesWatched: minutes,
    watchHours: minutes / 60,
    netSubscribers: gained - lost,
    subscribersGained: gained,
    subscribersLost: lost,
    estimatedRevenue: hasRevenue ? revenue : null,
    hasRevenue,
  };
}

/** Percentage change between two window totals of the same length. */
export function growthDelta(
  current: WindowTotals,
  previous: WindowTotals,
): {
  viewsPct: number | null;
  watchHoursPct: number | null;
  netSubsDelta: number;
} {
  const pct = (a: number, b: number): number | null => (b === 0 ? null : ((a - b) / b) * 100);
  return {
    viewsPct: pct(current.views, previous.views),
    watchHoursPct: pct(current.watchHours, previous.watchHours),
    netSubsDelta: current.netSubscribers - previous.netSubscribers,
  };
}

/** Naive keyword clustering: group videos by their most frequent shared tags. */
export function topicClusters(
  videos: VideoLike[],
  maxClusters = 6,
): Array<{ label: string; videoIds: string[]; totalViews: number }> {
  const tagCounts = new Map<string, { ids: Set<string>; views: number }>();
  for (const v of videos) {
    for (const raw of v.tags) {
      const tag = raw.trim().toLowerCase();
      if (tag.length < 3) continue;
      const entry = tagCounts.get(tag) ?? { ids: new Set(), views: 0 };
      entry.ids.add(v.videoId);
      entry.views += n(v.viewCount);
      tagCounts.set(tag, entry);
    }
  }
  return [...tagCounts.entries()]
    .filter(([, e]) => e.ids.size >= 2)
    .sort((a, b) => b[1].views - a[1].views)
    .slice(0, maxClusters)
    .map(([label, e]) => ({ label, videoIds: [...e.ids], totalViews: e.views }));
}
