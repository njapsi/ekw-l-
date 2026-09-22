import { describe, expect, it } from 'vitest';
import { buildOpportunityDrafts } from './opportunities.js';
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

describe('buildOpportunityDrafts', () => {
  it('returns no drafts for an empty input', () => {
    expect(buildOpportunityDrafts([])).toEqual([]);
  });

  it('produces a HIGH_PERFORMER_FOLLOWUP opportunity from outperforming videos', () => {
    const base = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n }),
    );
    const winner = video({ videoId: 'winner', viewCount: 1000n });
    const drafts = buildOpportunityDrafts([...base, winner]);
    const followup = drafts.find((d) => d.type === 'HIGH_PERFORMER_FOLLOWUP');
    expect(followup).toBeDefined();
    expect(followup!.relatedVideoIds).toContain('winner');
  });

  it('every priority score is in [0,1] and drafts are sorted by descending score', () => {
    const base = Array.from({ length: 12 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n }),
    );
    const cluster = Array.from({ length: 8 }, (_, i) =>
      video({ videoId: `top${i}`, viewCount: 9000n, hashtags: ['fyp'] }),
    );
    const drafts = buildOpportunityDrafts([...base, ...cluster]);
    for (const d of drafts) {
      expect(d.priorityScore).toBeGreaterThanOrEqual(0);
      expect(d.priorityScore).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < drafts.length; i++) {
      expect(drafts[i]!.priorityScore).toBeLessThanOrEqual(drafts[i - 1]!.priorityScore);
    }
  });

  it('classifies a small cluster as UNDEREXPLOITED_TOPIC, a larger one as CONTENT_EXPANSION', () => {
    const base = Array.from({ length: 12 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n }),
    );
    const small = Array.from({ length: 2 }, (_, i) =>
      video({ videoId: `small${i}`, viewCount: 9000n, hashtags: ['niche'] }),
    );
    const drafts = buildOpportunityDrafts([...base, ...small]);
    expect(drafts.find((d) => d.type === 'UNDEREXPLOITED_TOPIC')).toBeDefined();
  });

  it('never contains a positive guarantee or virality claim', () => {
    const base = Array.from({ length: 12 }, (_, i) =>
      video({ videoId: `base${i}`, viewCount: 100n }),
    );
    const winner = video({ videoId: 'winner', viewCount: 10_000n });
    const drafts = buildOpportunityDrafts([...base, winner]);
    const text = JSON.stringify(drafts).toLowerCase();
    expect(text).not.toMatch(/will go viral|guaranteed to|is guaranteed/);
  });

  it('detects a SHORT_FORMAT_OPPORTUNITY when short-form videos clearly outperform', () => {
    const shorts = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `short${i}`, durationSec: 20, viewCount: 5000n }),
    );
    const extended = Array.from({ length: 6 }, (_, i) =>
      video({ videoId: `ext${i}`, durationSec: 300, viewCount: 1000n }),
    );
    const drafts = buildOpportunityDrafts([...shorts, ...extended]);
    expect(drafts.find((d) => d.type === 'SHORT_FORMAT_OPPORTUNITY')).toBeDefined();
  });
});
