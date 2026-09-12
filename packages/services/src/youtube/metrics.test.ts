import { describe, expect, it } from 'vitest';
import {
  type DailyMetricLike,
  type VideoLike,
  engagementRate,
  growthDelta,
  performerSplit,
  publishingCadence,
  windowTotals,
} from './metrics.js';

function vid(over: Partial<VideoLike>): VideoLike {
  return {
    videoId: over.videoId ?? 'v',
    title: over.title ?? 't',
    publishedAt: over.publishedAt ?? new Date('2026-01-01'),
    durationSeconds: over.durationSeconds ?? 600,
    viewCount: over.viewCount ?? null,
    likeCount: over.likeCount ?? null,
    commentCount: over.commentCount ?? null,
    tags: over.tags ?? [],
  };
}

describe('youtube metrics', () => {
  it('engagementRate is null without views and a fraction otherwise', () => {
    expect(engagementRate(vid({ viewCount: null }))).toBeNull();
    expect(
      engagementRate(vid({ viewCount: 1000n, likeCount: 80n, commentCount: 20n })),
    ).toBeCloseTo(0.1);
  });

  it('performerSplit needs >= 5 videos and classifies around the median', () => {
    const few = [1, 2, 3].map((i) => vid({ videoId: `v${i}`, viewCount: BigInt(i * 100) }));
    expect(performerSplit(few).high).toHaveLength(0);

    const many = [10, 20, 30, 40, 50, 300].map((v, i) =>
      vid({ videoId: `v${i}`, viewCount: BigInt(v) }),
    );
    const split = performerSplit(many);
    expect(split.high.map((v) => v.videoId)).toContain('v5'); // the 300
    expect(split.low.length).toBeGreaterThan(0);
  });

  it('publishingCadence computes per-week rate and gaps', () => {
    const vids = [0, 7, 14, 40].map((d, i) =>
      vid({ videoId: `v${i}`, publishedAt: new Date(2026, 0, 1 + d) }),
    );
    const c = publishingCadence(vids);
    expect(c.videosPerWeek).toBeGreaterThan(0);
    expect(c.longestGapDays).toBeCloseTo(26, 0);
    expect(c.medianGapDays).toBeGreaterThan(0);
  });

  it('windowTotals sums only the trailing window and flags revenue presence', () => {
    const now = new Date('2026-06-01');
    const daily: DailyMetricLike[] = [
      {
        date: new Date('2026-05-20'),
        views: 100n,
        estimatedMinutesWatched: 600n,
        likes: 0n,
        comments: 0n,
        shares: 0n,
        subscribersGained: 3n,
        subscribersLost: 1n,
        estimatedRevenue: 1.5,
      },
      {
        date: new Date('2026-01-01'),
        views: 999n,
        estimatedMinutesWatched: 60n,
        likes: 0n,
        comments: 0n,
        shares: 0n,
        subscribersGained: 0n,
        subscribersLost: 0n,
        estimatedRevenue: null,
      },
    ];
    const w = windowTotals(daily, 28, now);
    expect(w.views).toBe(100);
    expect(w.watchHours).toBe(10);
    expect(w.netSubscribers).toBe(2);
    expect(w.hasRevenue).toBe(true);
    expect(w.estimatedRevenue).toBeCloseTo(1.5);
  });

  it('growthDelta returns null when the previous window is empty', () => {
    const now = new Date('2026-06-01');
    const cur = windowTotals(
      [
        {
          date: new Date('2026-05-25'),
          views: 50n,
          estimatedMinutesWatched: 0n,
          likes: 0n,
          comments: 0n,
          shares: 0n,
          subscribersGained: 0n,
          subscribersLost: 0n,
          estimatedRevenue: null,
        },
      ],
      28,
      now,
    );
    const prev = windowTotals([], 28, new Date('2026-05-01'));
    expect(growthDelta(cur, prev).viewsPct).toBeNull();
  });

  it('growthDelta computes an exact hand-verified percentage change', () => {
    const base = {
      days: 28,
      minutesWatched: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      estimatedRevenue: null,
      hasRevenue: false,
    };
    const current = { ...base, views: 150, watchHours: 20, netSubscribers: 30 };
    const previous = { ...base, views: 100, watchHours: 10, netSubscribers: 10 };
    const delta = growthDelta(current, previous);
    expect(delta.viewsPct).toBe(50); // (150-100)/100 * 100
    expect(delta.watchHoursPct).toBe(100); // (20-10)/10 * 100
    expect(delta.netSubsDelta).toBe(20); // 30 - 10
  });
});
