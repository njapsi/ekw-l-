import { describe, expect, it } from 'vitest';
import type { IssueDraft } from './rules.js';
import { CATEGORY_WEIGHTS, SEVERITY_PENALTY, scoreCrawl } from './scoring.js';

function issue(over: Partial<IssueDraft>): IssueDraft {
  return {
    code: 'X',
    category: 'metadata',
    severity: 'LOW',
    normalizedUrl: null,
    title: 't',
    detail: 'd',
    evidence: {},
    recommendedFix: 'f',
    confidence: 1,
    affectedUrlCount: 1,
    ...over,
  };
}

describe('scoreCrawl', () => {
  it('a clean crawl scores 100 across the board', () => {
    const s = scoreCrawl([], 20);
    expect(s.overall).toBe(100);
    expect(s.grade).toBe('A');
    expect(s.categories.every((c) => c.score === 100)).toBe(true);
  });

  it('publishes the weighting and per-severity penalties', () => {
    const s = scoreCrawl([], 1);
    expect(s.weights).toEqual(CATEGORY_WEIGHTS);
    expect(s.severityPenalties).toEqual(SEVERITY_PENALTY);
    const total = Object.values(s.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('a CRITICAL issue tanks its category and drags the overall down', () => {
    const s = scoreCrawl(
      [issue({ category: 'crawlability', severity: 'CRITICAL', affectedUrlCount: 50 })],
      50,
    );
    const crawl = s.categories.find((c) => c.category === 'crawlability')!;
    expect(crawl.score).toBeLessThan(65);
    expect(s.overall).toBeLessThan(100);
  });

  it('matches a hand-computed exact score for one site-wide CRITICAL issue', () => {
    // affectedFraction = min(1, 50/50) = 1; scale = 0.4 + 0.6*sqrt(1) = 1.0
    // penalty = 40 (CRITICAL) * 1.0 * 1 (confidence) = 40
    // crawlability score = round(100 - 40) = 60
    // overall = round(60*0.18 + 100*(1-0.18)) = round(10.8 + 82) = round(92.8) = 93
    const s = scoreCrawl(
      [issue({ category: 'crawlability', severity: 'CRITICAL', affectedUrlCount: 50 })],
      50,
    );
    const crawl = s.categories.find((c) => c.category === 'crawlability')!;
    expect(crawl.score).toBe(60);
    expect(crawl.weightedPenalty).toBe(40);
    expect(s.overall).toBe(93);
    expect(s.grade).toBe('A');
  });

  it('a site-wide issue is penalised more than a one-page issue', () => {
    const wide = scoreCrawl(
      [issue({ category: 'metadata', severity: 'MEDIUM', affectedUrlCount: 100 })],
      100,
    );
    const narrow = scoreCrawl(
      [issue({ category: 'metadata', severity: 'MEDIUM', affectedUrlCount: 1 })],
      100,
    );
    const wideScore = wide.categories.find((c) => c.category === 'metadata')!.score;
    const narrowScore = narrow.categories.find((c) => c.category === 'metadata')!.score;
    expect(wideScore).toBeLessThan(narrowScore);
  });

  it('never returns a negative score', () => {
    const many = Array.from({ length: 30 }, () =>
      issue({ category: 'security', severity: 'CRITICAL', affectedUrlCount: 100 }),
    );
    const s = scoreCrawl(many, 100);
    expect(s.categories.find((c) => c.category === 'security')!.score).toBe(0);
    expect(s.overall).toBeGreaterThanOrEqual(0);
  });
});
