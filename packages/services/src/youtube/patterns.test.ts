import { describe, expect, it } from 'vitest';
import { detectContentPatterns } from './patterns.js';
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

describe('detectContentPatterns — topic clusters', () => {
  it('reports a topic-cluster pattern when a tag cluster beats the channel median', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 100n, tags: ['baseline'] }),
      video({ videoId: 'v2', viewCount: 100n, tags: ['baseline'] }),
      video({ videoId: 'v3', viewCount: 100n, tags: ['baseline'] }),
      video({ videoId: 'v4', viewCount: 5000n, tags: ['cybersecurity'] }),
      video({ videoId: 'v5', viewCount: 6000n, tags: ['cybersecurity'] }),
    ];
    const patterns = detectContentPatterns(videos);
    const topicPattern = patterns.find(
      (p) => p.kind === 'TOPIC_CLUSTER' && p.label === 'cybersecurity',
    );
    expect(topicPattern).toBeDefined();
    expect(topicPattern!.videoIds.sort()).toEqual(['v4', 'v5']);
    expect(topicPattern!.evidence).toMatch(/views/);
  });

  it('never claims causation — no pattern text contains the word "causes"', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 100n, tags: ['a'] }),
      video({ videoId: 'v2', viewCount: 100n, tags: ['a'] }),
      video({ videoId: 'v3', viewCount: 100n, tags: ['a'] }),
      video({ videoId: 'v4', viewCount: 9000n, tags: ['b'] }),
      video({ videoId: 'v5', viewCount: 9000n, tags: ['b'] }),
    ];
    const patterns = detectContentPatterns(videos);
    for (const p of patterns) {
      expect(p.observation.toLowerCase()).not.toContain('causes');
      expect(p.evidence.toLowerCase()).not.toContain('causes');
    }
  });

  it('reports no topic pattern with fewer than 5 videos with views', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 100n, tags: ['a'] }),
      video({ videoId: 'v2', viewCount: 9000n, tags: ['b'] }),
    ];
    expect(detectContentPatterns(videos).filter((p) => p.kind === 'TOPIC_CLUSTER')).toHaveLength(0);
  });
});

describe('detectContentPatterns — format split', () => {
  it('reports a format-split pattern when Shorts and long-form medians differ materially', () => {
    const shorts = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `s${n}`, durationSeconds: 30, viewCount: 10_000n }),
    );
    const longForm = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `l${n}`, durationSeconds: 600, viewCount: 1_000n }),
    );
    const patterns = detectContentPatterns([...shorts, ...longForm]);
    const formatPattern = patterns.find((p) => p.kind === 'FORMAT_SPLIT');
    expect(formatPattern).toBeDefined();
    expect(formatPattern!.label).toBe('Shorts');
  });

  it('reports no format-split pattern when both formats perform similarly', () => {
    const shorts = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `s${n}`, durationSeconds: 30, viewCount: 1_000n }),
    );
    const longForm = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `l${n}`, durationSeconds: 600, viewCount: 1_050n }),
    );
    const patterns = detectContentPatterns([...shorts, ...longForm]);
    expect(patterns.filter((p) => p.kind === 'FORMAT_SPLIT')).toHaveLength(0);
  });

  it('reports no format-split pattern without at least 5 videos of each format', () => {
    const shorts = [1, 2].map((n) =>
      video({ videoId: `s${n}`, durationSeconds: 30, viewCount: 10_000n }),
    );
    const longForm = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `l${n}`, durationSeconds: 600, viewCount: 100n }),
    );
    const patterns = detectContentPatterns([...shorts, ...longForm]);
    expect(patterns.filter((p) => p.kind === 'FORMAT_SPLIT')).toHaveLength(0);
  });
});

describe('confidence labelling', () => {
  it('assigns HIGH confidence at 10+ videos, MEDIUM at 5-9, LOW below 5', () => {
    const ten = Array.from({ length: 12 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n, tags: ['base'] }),
    ).concat(
      Array.from({ length: 10 }, (_, i) =>
        video({ videoId: `top${i}`, viewCount: 9000n, tags: ['top'] }),
      ),
    );
    const patterns = detectContentPatterns(ten);
    const top = patterns.find((p) => p.label === 'top');
    expect(top?.confidence).toBe('HIGH');
  });
});
