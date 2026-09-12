import { describe, expect, it } from 'vitest';
import { renderAsset } from './render.js';
import { ALL_ASSET_TYPES, GEN_SCHEMAS, type ContentAssetTypeKey } from './schemas.js';

const SAMPLE: Record<ContentAssetTypeKey, Record<string, unknown>> = {
  YT_TITLE_ALTERNATIVES: { options: ['A', 'B', 'C'], keyIdeaIds: ['k1'] },
  YT_DESCRIPTION: { body: 'A description.', keyIdeaIds: ['k1'] },
  YT_CHAPTERS: {
    chapters: [{ timestamp: '0:00', title: 'Intro' }, { title: 'Point one' }],
    keyIdeaIds: ['k1'],
  },
  SHORTS_IDEA: {
    title: 'Short',
    hook: 'Watch this',
    beats: ['a', 'b'],
    onScreenText: ['x'],
    keyIdeaIds: ['k1'],
  },
  TIKTOK_IDEA: {
    title: 'TT',
    concept: 'do the thing',
    hook: 'hey',
    beats: ['a', 'b'],
    keyIdeaIds: ['k1'],
  },
  TIKTOK_CAPTION: { caption: 'nice', hashtags: ['fun', '#growth'], keyIdeaIds: ['k1'] },
  HOOK: { options: ['h1', 'h2', 'h3'], format: 'spoken', keyIdeaIds: ['k1'] },
  SCRIPT: {
    format: 'short-form',
    hook: 'hi',
    script: 'body',
    callToAction: 'follow',
    keyIdeaIds: ['k1'],
  },
  SOCIAL_POST: { platform: 'x', body: 'post', hashtags: ['a'], keyIdeaIds: ['k1'] },
  BLOG_IDEA: {
    workingTitle: 'Title',
    angle: 'angle',
    targetReader: 'devs',
    keyPoints: ['p1', 'p2'],
    keyIdeaIds: ['k1'],
  },
  SEO_ARTICLE_OUTLINE: {
    workingTitle: 'Guide',
    targetQuery: 'how to x',
    searchIntent: 'informational',
    sections: [
      { heading: 'A', bullets: ['x'] },
      { heading: 'B', bullets: ['y'] },
      { heading: 'C', bullets: ['z'] },
    ],
    internalLinkIdeas: ['/a'],
    keyIdeaIds: ['k1'],
  },
  FAQ: {
    items: [
      { question: 'Q1?', answer: 'A1' },
      { question: 'Q2?', answer: 'A2' },
      { question: 'Q3?', answer: 'A3' },
    ],
    keyIdeaIds: ['k1'],
  },
  NEWSLETTER_IDEA: {
    subjectLines: ['s1', 's2'],
    angle: 'angle',
    outline: ['o1', 'o2'],
    keyIdeaIds: ['k1'],
  },
};

describe('content schemas', () => {
  it('covers exactly the 13 deliverable types', () => {
    expect(ALL_ASSET_TYPES).toHaveLength(13);
    expect(Object.keys(GEN_SCHEMAS)).toHaveLength(13);
  });

  it('each sample validates against its generation schema', () => {
    for (const type of ALL_ASSET_TYPES) {
      expect(() => GEN_SCHEMAS[type].schema.parse(SAMPLE[type]), type).not.toThrow();
    }
  });

  it('renderAsset produces a non-empty title + body for every type', () => {
    for (const type of ALL_ASSET_TYPES) {
      const r = renderAsset(type, SAMPLE[type]);
      expect(r.title.length, type).toBeGreaterThan(0);
      expect(r.body.length, type).toBeGreaterThan(0);
      expect(r.structured, type).toEqual(SAMPLE[type]);
    }
  });

  it('marks the right types as multi', () => {
    const multi = ALL_ASSET_TYPES.filter((t) => GEN_SCHEMAS[t].multi);
    expect(multi).toEqual(
      expect.arrayContaining([
        'SHORTS_IDEA',
        'TIKTOK_IDEA',
        'SOCIAL_POST',
        'BLOG_IDEA',
        'NEWSLETTER_IDEA',
      ]),
    );
    expect(GEN_SCHEMAS.YT_DESCRIPTION.multi).toBe(false);
    expect(GEN_SCHEMAS.FAQ.multi).toBe(false);
  });
});
