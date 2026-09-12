import { describe, expect, it } from 'vitest';
import {
  type TikTokVideoLike,
  engagementRate,
  performerSplit,
  postingCadence,
  themeClusters,
} from './metrics.js';

function vid(over: Partial<TikTokVideoLike> = {}): TikTokVideoLike {
  return {
    videoId: over.videoId ?? 'v',
    caption: over.caption ?? null,
    createTime: over.createTime ?? new Date('2026-01-01'),
    durationSec: over.durationSec ?? 30,
    viewCount: over.viewCount ?? null,
    likeCount: over.likeCount ?? null,
    commentCount: over.commentCount ?? null,
    shareCount: over.shareCount ?? null,
    hashtags: over.hashtags ?? [],
  };
}

describe('tiktok metrics', () => {
  it('engagementRate is null without views (including a genuine zero-view video) and a fraction otherwise', () => {
    expect(engagementRate(vid({ viewCount: null }))).toBeNull();
    expect(engagementRate(vid({ viewCount: 0n, likeCount: 5n }))).toBeNull();
    // (60 likes + 30 comments + 10 shares) / 1000 views = 0.1
    expect(
      engagementRate(vid({ viewCount: 1000n, likeCount: 60n, commentCount: 30n, shareCount: 10n })),
    ).toBeCloseTo(0.1);
  });

  it('postingCadence needs >= 2 dated videos and computes an exact per-week rate + gap', () => {
    const only = new Date('2026-01-01');
    expect(postingCadence([vid({ videoId: 'v0', createTime: only })])).toEqual({
      postsPerWeek: 0,
      medianGapDays: null,
      firstAt: only,
      lastAt: only,
    });

    const videos = [0, 7, 14, 40].map((d, i) =>
      vid({ videoId: `v${i}`, createTime: new Date(2026, 0, 1 + d) }),
    );
    const c = postingCadence(videos);
    // 4 posts over a 40-day (40/7-week) span: 4 / (40/7) = 0.7 exactly.
    expect(c.postsPerWeek).toBeCloseTo(0.7);
    // gaps are [7, 7, 26] days, sorted ascending; the function indexes the
    // sorted array at floor(length/2) rather than averaging for even counts.
    expect(c.medianGapDays).toBe(7);
    expect(c.firstAt).toEqual(new Date(2026, 0, 1));
    expect(c.lastAt).toEqual(new Date(2026, 0, 41));
  });

  it('performerSplit needs >= 5 videos with views and classifies around the (possibly averaged) median', () => {
    const few = [1, 2, 3].map((v, i) => vid({ videoId: `v${i}`, viewCount: BigInt(v * 100) }));
    expect(performerSplit(few)).toEqual({ high: [], low: [], median: 0 });

    // Six videos, even count: median = average of the two middle sorted
    // values (30, 40) = 35. high >= 1.5*35=52.5 -> only 300. low <= 0.5*35=17.5 -> only 10.
    const many = [10, 20, 30, 40, 50, 300].map((v, i) =>
      vid({ videoId: `v${i}`, viewCount: BigInt(v) }),
    );
    const split = performerSplit(many);
    expect(split.median).toBe(35);
    expect(split.high.map((v) => v.videoId)).toEqual(['v5']); // the 300
    expect(split.low.map((v) => v.videoId)).toEqual(['v0']); // the 10
  });

  it('themeClusters groups videos sharing a hashtag (needs >= 2 videos per tag), ranked by total views', () => {
    const videos = [
      vid({ videoId: 'v0', viewCount: 100n, hashtags: ['howto', 'beginner'] }),
      vid({ videoId: 'v1', viewCount: 200n, hashtags: ['howto'] }),
      vid({ videoId: 'v2', viewCount: 50n, hashtags: ['advanced'] }),
    ];
    const clusters = themeClusters(videos);
    // 'beginner' and 'advanced' each appear on only one video -> excluded.
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      tag: 'howto',
      totalViews: 300, // 100 + 200, hand-verified
    });
    expect(clusters[0]?.videoIds.sort()).toEqual(['v0', 'v1']);
  });

  it('themeClusters is case-insensitive and respects maxClusters', () => {
    const videos = [
      vid({ videoId: 'a', viewCount: 10n, hashtags: ['Tag'] }),
      vid({ videoId: 'b', viewCount: 10n, hashtags: ['tag'] }),
    ];
    const clusters = themeClusters(videos, 1);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.tag).toBe('tag');
    expect(clusters[0]?.videoIds.sort()).toEqual(['a', 'b']);
  });
});
