import { describe, expect, it } from 'vitest';
import { detectContentPatterns } from './patterns.js';
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

describe('detectContentPatterns — hashtag clusters', () => {
  it('detects a hashtag cluster whose average views exceed the account median', () => {
    // 12 baseline videos with low views set the median well below the cluster.
    const base = Array.from({ length: 12 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n, hashtags: [] }),
    );
    const top = Array.from({ length: 3 }, (_, i) =>
      video({ videoId: `top${i}`, viewCount: 9000n, hashtags: ['fyp'] }),
    );
    const patterns = detectContentPatterns([...base, ...top]);
    const hashtagPattern = patterns.find((p) => p.kind === 'HASHTAG_CLUSTER' && p.label === '#fyp');
    expect(hashtagPattern).toBeDefined();
    expect(hashtagPattern!.videoIds).toHaveLength(3);
  });

  it('never claims causation — no pattern text contains "causes"', () => {
    const base = Array.from({ length: 12 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n }),
    );
    const top = Array.from({ length: 3 }, (_, i) =>
      video({ videoId: `top${i}`, viewCount: 9000n, hashtags: ['fyp'] }),
    );
    const patterns = detectContentPatterns([...base, ...top]);
    for (const p of patterns) {
      expect(p.observation.toLowerCase()).not.toContain('causes');
      expect(p.evidence.toLowerCase()).not.toContain('causes');
    }
  });

  it('does not report a cluster with fewer than 2 shared videos', () => {
    const videos = [
      video({ videoId: 'a', hashtags: ['solo'], viewCount: 10_000n }),
      ...Array.from({ length: 5 }, (_, i) => video({ videoId: `v${i}`, viewCount: 100n })),
    ];
    const patterns = detectContentPatterns(videos);
    expect(patterns.find((p) => p.label === '#solo')).toBeUndefined();
  });
});

describe('detectContentPatterns — duration split', () => {
  it('detects a short-vs-extended split with at least 5 of each and a 1.2x ratio', () => {
    const shorts = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `short${i}`, durationSec: 20, viewCount: 5000n }),
    );
    const extended = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `ext${i}`, durationSec: 300, viewCount: 1000n }),
    );
    const patterns = detectContentPatterns([...shorts, ...extended]);
    const durationPattern = patterns.find((p) => p.kind === 'DURATION_SPLIT');
    expect(durationPattern).toBeDefined();
    expect(durationPattern!.label).toContain('Short-form');
  });

  it('does not report a duration split with fewer than 5 of either bucket', () => {
    const shorts = Array.from({ length: 3 }, (_, i) =>
      video({ videoId: `short${i}`, durationSec: 20, viewCount: 5000n }),
    );
    const extended = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `ext${i}`, durationSec: 300, viewCount: 1000n }),
    );
    const patterns = detectContentPatterns([...shorts, ...extended]);
    expect(patterns.find((p) => p.kind === 'DURATION_SPLIT')).toBeUndefined();
  });

  it('does not report a duration split below the 1.2x ratio threshold', () => {
    const shorts = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `short${i}`, durationSec: 20, viewCount: 1050n }),
    );
    const extended = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `ext${i}`, durationSec: 300, viewCount: 1000n }),
    );
    const patterns = detectContentPatterns([...shorts, ...extended]);
    expect(patterns.find((p) => p.kind === 'DURATION_SPLIT')).toBeUndefined();
  });
});

describe('detectContentPatterns confidence', () => {
  it('labels HIGH confidence for >=10 videos, MEDIUM for >=5, LOW below', () => {
    const base = Array.from({ length: 12 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n }),
    );
    const highCluster = Array.from({ length: 10 }, (_, i) =>
      video({ videoId: `hi${i}`, viewCount: 9000n, hashtags: ['big'] }),
    );
    const patterns = detectContentPatterns([...base, ...highCluster]);
    const p = patterns.find((x) => x.label === '#big')!;
    expect(p.confidence).toBe('HIGH');
  });
});
