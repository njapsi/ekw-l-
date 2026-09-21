import { describe, expect, it } from 'vitest';
import { buildOpportunityDrafts } from './opportunities.js';
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

describe('buildOpportunityDrafts', () => {
  it('returns no opportunities for too few videos', () => {
    const videos = [video({ videoId: 'v1', viewCount: 100n })];
    expect(buildOpportunityDrafts(videos)).toEqual([]);
  });

  it('surfaces a HIGH_PERFORMER_FOLLOWUP opportunity when videos outperform peers', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 1000n }),
      video({ videoId: 'v2', viewCount: 1000n }),
      video({ videoId: 'v3', viewCount: 1000n }),
      video({ videoId: 'v4', viewCount: 1000n }),
      video({ videoId: 'v5', viewCount: 10_000n, title: 'Big hit' }),
    ];
    const drafts = buildOpportunityDrafts(videos);
    const followUp = drafts.find((d) => d.type === 'HIGH_PERFORMER_FOLLOWUP');
    expect(followUp).toBeDefined();
    expect(followUp!.relatedVideoIds).toContain('v5');
    expect(followUp!.evidence.length).toBeGreaterThan(0);
  });

  it('every priorityScore is in [0, 1] and drafts are sorted descending', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 100n, tags: ['a'] }),
      video({ videoId: 'v2', viewCount: 100n, tags: ['a'] }),
      video({ videoId: 'v3', viewCount: 100n, tags: ['a'] }),
      video({ videoId: 'v4', viewCount: 9000n, tags: ['b'] }),
      video({ videoId: 'v5', viewCount: 9500n, tags: ['b'] }),
    ];
    const drafts = buildOpportunityDrafts(videos);
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d.priorityScore).toBeGreaterThanOrEqual(0);
      expect(d.priorityScore).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < drafts.length; i++) {
      expect(drafts[i - 1]!.priorityScore).toBeGreaterThanOrEqual(drafts[i]!.priorityScore);
    }
  });

  it('classifies a small (<=3 video) above-median cluster as UNDEREXPLOITED_TOPIC, a larger one as CONTENT_EXPANSION', () => {
    const base = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `base${n}`, viewCount: 100n, tags: ['baseline'] }),
    );
    const small = [1, 2].map((n) =>
      video({ videoId: `small${n}`, viewCount: 9000n, tags: ['niche'] }),
    );
    const drafts = buildOpportunityDrafts([...base, ...small]);
    const underexploited = drafts.find((d) => d.type === 'UNDEREXPLOITED_TOPIC');
    expect(underexploited).toBeDefined();
    expect(underexploited!.relatedVideoIds.sort()).toEqual(['small1', 'small2']);
  });

  it('never claims a guaranteed outcome — no draft text contains "guarantee" or "viral"', () => {
    const videos = [
      video({ videoId: 'v1', viewCount: 1000n }),
      video({ videoId: 'v2', viewCount: 1000n }),
      video({ videoId: 'v3', viewCount: 1000n }),
      video({ videoId: 'v4', viewCount: 1000n }),
      video({ videoId: 'v5', viewCount: 10_000n }),
    ];
    const drafts = buildOpportunityDrafts(videos);
    for (const d of drafts) {
      expect(d.title.toLowerCase()).not.toContain('guarantee');
      expect(d.title.toLowerCase()).not.toContain('viral');
      expect(d.description.toLowerCase()).not.toContain('guarantee');
      expect(d.description.toLowerCase()).not.toContain('viral');
    }
  });

  it('surfaces a SHORTS_OPPORTUNITY when Shorts materially outperform long-form', () => {
    const shorts = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `s${n}`, durationSeconds: 30, viewCount: 10_000n }),
    );
    const longForm = [1, 2, 3, 4, 5].map((n) =>
      video({ videoId: `l${n}`, durationSeconds: 600, viewCount: 500n }),
    );
    const drafts = buildOpportunityDrafts([...shorts, ...longForm]);
    expect(drafts.some((d) => d.type === 'SHORTS_OPPORTUNITY')).toBe(true);
  });
});
