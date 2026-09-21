import { describe, expect, it } from 'vitest';
import { benchmarkVideos, classifyFormat, compareVideos } from './benchmark.js';
import type { VideoLike } from './metrics.js';

function video(overrides: Partial<VideoLike> & { videoId: string }): VideoLike {
  return {
    title: overrides.videoId,
    publishedAt: new Date('2026-01-01'),
    durationSeconds: 600,
    viewCount: null,
    likeCount: null,
    commentCount: null,
    tags: [],
    ...overrides,
  };
}

describe('classifyFormat', () => {
  it('classifies at or under 180s as a Short', () => {
    expect(classifyFormat(180)).toBe('short');
    expect(classifyFormat(60)).toBe('short');
  });
  it('classifies over 180s as long-form', () => {
    expect(classifyFormat(181)).toBe('long_form');
  });
  it('treats an unknown duration as long-form (never guesses Short)', () => {
    expect(classifyFormat(null)).toBe('long_form');
  });
});

describe('benchmarkVideos', () => {
  it('reports INSUFFICIENT_DATA when fewer than 5 comparable videos have views', () => {
    const videos = [1, 2, 3].map((n) => video({ videoId: `v${n}`, viewCount: BigInt(1000 * n) }));
    const result = benchmarkVideos(videos);
    expect(result.every((r) => r.classification === 'INSUFFICIENT_DATA')).toBe(true);
    expect(result[0]!.peerMedianViews).toBeNull();
  });

  it('classifies a video at >=1.5x the format median as OUTPERFORMING', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 1000n }),
      video({ videoId: 'v2', viewCount: 1000n }),
      video({ videoId: 'v3', viewCount: 1000n }),
      video({ videoId: 'v4', viewCount: 1000n }),
      video({ videoId: 'v5', viewCount: 5000n }), // 5x median
    ];
    const result = benchmarkVideos(videos);
    const v5 = result.find((r) => r.videoId === 'v5')!;
    expect(v5.classification).toBe('OUTPERFORMING');
    expect(v5.ratioToPeerMedian).toBeGreaterThanOrEqual(1.5);
  });

  it('classifies a video at <=0.5x the format median as UNDERPERFORMING', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 1000n }),
      video({ videoId: 'v2', viewCount: 1000n }),
      video({ videoId: 'v3', viewCount: 1000n }),
      video({ videoId: 'v4', viewCount: 1000n }),
      video({ videoId: 'v5', viewCount: 100n }), // 0.1x median
    ];
    const result = benchmarkVideos(videos);
    const v5 = result.find((r) => r.videoId === 'v5')!;
    expect(v5.classification).toBe('UNDERPERFORMING');
  });

  it('classifies a video near the median as TYPICAL', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 1000n }),
      video({ videoId: 'v2', viewCount: 1000n }),
      video({ videoId: 'v3', viewCount: 1000n }),
      video({ videoId: 'v4', viewCount: 1000n }),
      video({ videoId: 'v5', viewCount: 1100n }),
    ];
    const result = benchmarkVideos(videos);
    const v5 = result.find((r) => r.videoId === 'v5')!;
    expect(v5.classification).toBe('TYPICAL');
  });

  it('benchmarks Shorts against Shorts and long-form against long-form separately', () => {
    const shorts = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `s${n}`, durationSeconds: 30, viewCount: 10_000n }),
    );
    const longForm = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `l${n}`, durationSeconds: 600, viewCount: 100n }),
    );
    const result = benchmarkVideos([...shorts, ...longForm]);
    // Every short is near the Shorts median (10,000) and every long-form
    // video is near the long-form median (100) — neither bucket should
    // contaminate the other's classification.
    expect(
      result.filter((r) => r.videoId.startsWith('s')).every((r) => r.classification === 'TYPICAL'),
    ).toBe(true);
    expect(
      result.filter((r) => r.videoId.startsWith('l')).every((r) => r.classification === 'TYPICAL'),
    ).toBe(true);
  });

  it('reports INSUFFICIENT_DATA for a video with no view count at all', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 1000n }),
      video({ videoId: 'v2', viewCount: 1000n }),
      video({ videoId: 'v3', viewCount: 1000n }),
      video({ videoId: 'v4', viewCount: 1000n }),
      video({ videoId: 'v5', viewCount: null }),
    ];
    const result = benchmarkVideos(videos);
    expect(result.find((r) => r.videoId === 'v5')!.classification).toBe('INSUFFICIENT_DATA');
  });
});

describe('compareVideos', () => {
  it('is the same benchmarking logic exposed for a caller-selected set', () => {
    const videos = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `v${n}`, viewCount: BigInt(1000 * n) }),
    );
    expect(compareVideos(videos)).toEqual(benchmarkVideos(videos));
  });
});
