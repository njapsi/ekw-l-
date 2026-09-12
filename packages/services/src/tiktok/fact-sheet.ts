import {
  type TikTokVideoLike,
  engagementRate,
  performerSplit,
  postingCadence,
  themeClusters,
} from './metrics.js';

export interface Fact {
  id: string;
  label: string;
  value: string | number;
  kind: 'fact' | 'calculated_metric';
  origin: string;
}

export interface FactSheet {
  accountName: string;
  facts: Fact[];
  numbers: number[];
  videoCountConsidered: number;
  hasStats: boolean;
}

export interface FactSheetInput {
  account: {
    openId: string;
    displayName: string | null;
    username: string | null;
    followerCount: bigint | null;
    likesCount: bigint | null;
    videoCountStat: number | null;
    hasStatsScope: boolean;
  };
  videos: TikTokVideoLike[];
}

const num = (v: bigint | null): number | null => (v == null ? null : Number(v));

export function buildFactSheet(input: FactSheetInput): FactSheet {
  const facts: Fact[] = [];
  const add = (f: Fact) => facts.push(f);
  const name = input.account.displayName ?? input.account.username ?? input.account.openId;

  if (input.account.hasStatsScope) {
    if (num(input.account.followerCount) != null) {
      add({
        id: 'account.followers',
        label: 'Followers',
        value: num(input.account.followerCount)!,
        kind: 'fact',
        origin: 'tiktok.display.v2:user.info',
      });
    }
    if (num(input.account.likesCount) != null) {
      add({
        id: 'account.totalLikes',
        label: 'Total likes across the account',
        value: num(input.account.likesCount)!,
        kind: 'fact',
        origin: 'tiktok.display.v2:user.info',
      });
    }
    if (input.account.videoCountStat != null) {
      add({
        id: 'account.videoCount',
        label: 'Public video count (API stat)',
        value: input.account.videoCountStat,
        kind: 'fact',
        origin: 'tiktok.display.v2:user.info',
      });
    }
  }

  const vids = input.videos;
  add({
    id: 'videos.analyzed',
    label: 'Videos included in this analysis',
    value: vids.length,
    kind: 'fact',
    origin: 'tiktok.display.v2:video.list',
  });

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
  }

  const eng = vids.map(engagementRate).filter((x): x is number => x != null);
  if (eng.length > 0) {
    const avg = eng.reduce((s, x) => s + x, 0) / eng.length;
    add({
      id: 'videos.avgEngagementPct',
      label: 'Average engagement rate percent (likes+comments+shares / views)',
      value: Number((avg * 100).toFixed(2)),
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }

  const cadence = postingCadence(vids);
  add({
    id: 'posting.perWeek',
    label: 'Average posts per week (analyzed range)',
    value: Number(cadence.postsPerWeek.toFixed(2)),
    kind: 'calculated_metric',
    origin: 'derived',
  });
  if (cadence.medianGapDays != null) {
    add({
      id: 'posting.medianGapDays',
      label: 'Median days between posts',
      value: Number(cadence.medianGapDays.toFixed(1)),
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }

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

  themeClusters(vids).forEach((c, i) => {
    add({
      id: `theme.cluster.${i}`,
      label: `Hashtag theme "#${c.tag}" — ${c.videoIds.length} videos, ${c.totalViews} total views`,
      value: c.totalViews,
      kind: 'calculated_metric',
      origin: 'derived',
    });
  });

  const durations = vids.map((v) => v.durationSec).filter((x): x is number => x != null);
  if (durations.length > 0) {
    add({
      id: 'videos.avgDurationSec',
      label: 'Average video duration (seconds)',
      value: Math.round(durations.reduce((s, x) => s + x, 0) / durations.length),
      kind: 'calculated_metric',
      origin: 'derived',
    });
  }

  const numbers = facts
    .map((f) => (typeof f.value === 'number' ? f.value : Number(f.value)))
    .filter((x) => Number.isFinite(x));

  return {
    accountName: name,
    facts,
    numbers,
    videoCountConsidered: vids.length,
    hasStats: input.account.hasStatsScope,
  };
}
