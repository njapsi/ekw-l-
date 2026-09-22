import { describe, expect, it } from 'vitest';
import { benchmarkVideos, classifyDuration, compareVideos } from './benchmark.js';
import type { TikTokVideoLike } from './metrics.js';

function video(overrides: Partial<TikTokVideoLike> = {}): TikTokVideoLike {
  return {
    videoId: 'v1',
    caption: 'test',
    createTime: new Date('2026-01-01'),
    durationSec: 30,
    viewCount: 1000n,
    likeCount: 50n,
    commentCount: 10n,
    shareCount: 5n,
    hashtags: [],
    ...overrides,
  };
}

describe('classifyDuration', () => {
  it('classifies at the 60s boundary', () => {
    expect(classifyDuration(60)).toBe('short');
    expect(classifyDuration(61)).toBe('extended');
    expect(classifyDuration(null)).toBe('short');
  });
});

describe('benchmarkVideos', () => {
  it('reports INSUFFICIENT_DATA with fewer than 5 comparable peers', () => {
    const videos = Array.from({ length: 3 }, (_, i) =>
      video({ videoId: `v${i}`, viewCount: BigInt(1000 * (i + 1)) }),
    );
    const result = benchmarkVideos(videos);
    expect(result.every((r) => r.classification === 'INSUFFICIENT_DATA')).toBe(true);
  });

  it('classifies a video >=1.5x the peer median as OUTPERFORMING', () => {
    const base = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n }),
    );
    const winner = video({ videoId: 'winner', viewCount: 1000n });
    const result = benchmarkVideos([...base, winner]);
    const winnerResult = result.find((r) => r.videoId === 'winner')!;
    expect(winnerResult.classification).toBe('OUTPERFORMING');
    expect(winnerResult.ratioToPeerMedian).toBeGreaterThanOrEqual(1.5);
  });

  it('classifies a video <=0.5x the peer median as UNDERPERFORMING', () => {
    const base = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 1000n }),
    );
    const loser = video({ videoId: 'loser', viewCount: 100n });
    const result = benchmarkVideos([...base, loser]);
    const loserResult = result.find((r) => r.videoId === 'loser')!;
    expect(loserResult.classification).toBe('UNDERPERFORMING');
  });

  it('classifies a video within the typical band as TYPICAL', () => {
    const videos = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `v${i}`, viewCount: 1000n }),
    );
    const result = benchmarkVideos(videos);
    expect(result.every((r) => r.classification === 'TYPICAL')).toBe(true);
  });

  it('never contaminates a short-form comparison with extended videos and vice versa', () => {
    const shorts = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `short${i}`, durationSec: 20, viewCount: 100n }),
    );
    const extended = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `ext${i}`, durationSec: 300, viewCount: 100_000n }),
    );
    const result = benchmarkVideos([...shorts, ...extended]);
    // Each bucket's own median matches its own values, so every video is
    // TYPICAL relative to its own bucket despite the huge cross-bucket gap.
    expect(result.every((r) => r.classification === 'TYPICAL')).toBe(true);
  });

  it('reports INSUFFICIENT_DATA for a video with a null view count', () => {
    const videos = [
      video({ videoId: 'no-views', viewCount: null }),
      ...Array.from({ length: 5 }, (_, i) => video({ videoId: `v${i}`, viewCount: 1000n })),
    ];
    const result = benchmarkVideos(videos);
    expect(result.find((r) => r.videoId === 'no-views')!.classification).toBe('INSUFFICIENT_DATA');
  });

  it('compareVideos is the same logic as benchmarkVideos', () => {
    const videos = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `v${i}`, viewCount: 1000n }),
    );
    expect(compareVideos(videos)).toEqual(benchmarkVideos(videos));
  });
});
