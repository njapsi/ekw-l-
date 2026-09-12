import {
  type DailyMetricLike,
  type VideoLike,
  engagementRate,
  growthDelta,
  performerSplit,
  publishingCadence,
  topicClusters,
  windowTotals,
} from './metrics.js';

/**
 * A fact sheet is the ONLY quantitative context handed to the analyst model.
 * Each fact has a stable `id`, a human `label`, a `value`, a `kind`
 * (`fact` = straight from the API, `calculated_metric` = derived here) and an
 * `origin` for provenance. The agent must cite fact ids; a grounding check
 * rejects any output that references a fact we did not provide or states a
 * number that is not in this sheet.
 */
export interface Fact {
  id: string;
  label: string;
  value: string | number;
  kind: 'fact' | 'calculated_metric';
  origin: string;
}

export interface FactSheet {
  channelId: string;
  channelTitle: string;
  facts: Fact[];
  /** All numeric values that appear in the sheet, for the grounding check. */
  numbers: number[];
  videoCountConsidered: number;
  hasAnalytics: boolean;
}

export interface FactSheetInput {
  channel: {
    channelId: string;
    title: string;
    subscriberCount: bigint | null;
    hiddenSubscriberCount: boolean;
    viewCount: bigint | null;
    videoCount: number | null;
  };
  videos: VideoLike[];
  daily: DailyMetricLike[];
  now?: Date;
}

const num = (v: bigint | null): number | null => (v == null ? null : Number(v));

export function buildFactSheet(input: FactSheetInput): FactSheet {
  const now = input.now ?? new Date();
  const facts: Fact[] = [];
  const add = (f: Fact) => facts.push(f);

  const subs = input.channel.hiddenSubscriberCount ? null : num(input.channel.subscriberCount);
  if (subs != null) {
    add({
      id: 'channel.subscribers',
      label: 'Subscribers',
      value: subs,
      kind: 'fact',
      origin: 'youtube.data.v3:channels.statistics',
    });
  }
  if (num(input.channel.viewCount) != null) {
    add({
      id: 'channel.lifetimeViews',
      label: 'Lifetime channel views',
      value: num(input.channel.viewCount)!,
      kind: 'fact',
      origin: 'youtube.data.v3:channels.statistics',
    });
  }
  if (input.channel.videoCount != null) {
    add({
      id: 'channel.videoCount',
      label: 'Public video count',
      value: input.channel.videoCount,
      kind: 'fact',
      origin: 'youtube.data.v3:channels.statistics',
    });
  }

  const vids = input.videos;
  add({
    id: 'videos.analyzed',
    label: 'Videos included in this analysis',
    value: vids.length,
    kind: 'fact',
    origin: 'youtube.data.v3:videos',
  });

  // Per-video view stats
  const views = vids.map((v) => num(v.viewCount)).filter((x): x is number => x != null);
  if (views.length > 0) {
    const sorted = [...views].sort((a, b) => a - b);
    add({
      id: 'videos.medianViews',
      label: 'Median views per analyzed video',
      value: Math.round(sorted[Math.floor(sorted.length / 2)]!),
      kind: 'calculated_metric',
      origin: 'derived',
    });
    add({
      id: 'videos.maxViews',
      label: 'Most-viewed analyzed video',
      value: Math.max(...views),
      kind: 'calculated_metric',
      origin: 'derived',
    });
    add({
      id: 'videos.minViews',
      label: 'Least-viewed analyzed video',
      value: Math.min(...views),
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }

  // Engagement
  const engRates = vids.map(engagementRate).filter((x): x is number => x != null);
  if (engRates.length > 0) {
    const avgEng = engRates.reduce((s, x) => s + x, 0) / engRates.length;
    add({
      id: 'videos.avgEngagementPct',
      label: 'Average engagement rate percent (likes+comments / views)',
      value: Number((avgEng * 100).toFixed(2)),
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }

  // Publishing cadence
  const cadence = publishingCadence(vids);
  add({
    id: 'publishing.perWeek',
    label: 'Average uploads per week (analyzed range)',
    value: Number(cadence.videosPerWeek.toFixed(2)),
    kind: 'calculated_metric',
    origin: 'derived',
  });
  if (cadence.medianGapDays != null) {
    add({
      id: 'publishing.medianGapDays',
      label: 'Median days between uploads',
      value: Number(cadence.medianGapDays.toFixed(1)),
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }
  if (cadence.longestGapDays != null) {
    add({
      id: 'publishing.longestGapDays',
      label: 'Longest gap between uploads (days)',
      value: Number(cadence.longestGapDays.toFixed(0)),
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }

  // Performer split
  const split = performerSplit(vids);
  if (split.high.length || split.low.length) {
    add({
      id: 'videos.highPerformers',
      label: 'High-performing videos (>= 1.5x median views)',
      value: split.high.length,
      kind: 'calculated_metric',
      origin: 'derived',
    });
    add({
      id: 'videos.lowPerformers',
      label: 'Underperforming videos (<= 0.5x median views)',
      value: split.low.length,
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }

  // Topic clusters
  const clusters = topicClusters(vids);
  clusters.forEach((c, i) => {
    add({
      id: `topic.cluster.${i}`,
      label: `Topic cluster "${c.label}" — ${c.videoIds.length} videos, ${c.totalViews} total views`,
      value: c.totalViews,
      kind: 'calculated_metric',
      origin: 'derived',
    });
  });

  // Analytics windows
  const hasAnalytics = input.daily.length > 0;
  if (hasAnalytics) {
    const w28 = windowTotals(input.daily, 28, now);
    const wPrev28 = windowTotals(
      input.daily.filter((d) => d.date.getTime() < now.getTime() - 28 * 86_400_000),
      28,
      new Date(now.getTime() - 28 * 86_400_000),
    );
    add({
      id: 'analytics.views28d',
      label: 'Views, last 28 days',
      value: w28.views,
      kind: 'fact',
      origin: 'youtube.analytics.v2',
    });
    add({
      id: 'analytics.watchHours28d',
      label: 'Watch hours, last 28 days',
      value: Math.round(w28.watchHours),
      kind: 'calculated_metric',
      origin: 'derived from youtube.analytics.v2',
    });
    add({
      id: 'analytics.netSubs28d',
      label: 'Net subscribers, last 28 days',
      value: w28.netSubscribers,
      kind: 'fact',
      origin: 'youtube.analytics.v2',
    });
    const delta = growthDelta(w28, wPrev28);
    if (delta.viewsPct != null) {
      add({
        id: 'analytics.viewsChangePct',
        label: 'Views change vs previous 28 days (%)',
        value: Number(delta.viewsPct.toFixed(1)),
        kind: 'calculated_metric',
        origin: 'derived',
      });
    }
    const w365 = windowTotals(input.daily, 365, now);
    add({
      id: 'analytics.watchHours365d',
      label: 'Watch hours, last 365 days (all watch time)',
      value: Math.round(w365.watchHours),
      kind: 'calculated_metric',
      origin: 'derived from youtube.analytics.v2',
    });
  }

  const numbers = facts
    .map((f) => (typeof f.value === 'number' ? f.value : Number(f.value)))
    .filter((x) => Number.isFinite(x));

  return {
    channelId: input.channel.channelId,
    channelTitle: input.channel.title,
    facts,
    numbers,
    videoCountConsidered: vids.length,
    hasAnalytics,
  };
}
