import { describe, expect, it } from 'vitest';
import { type EngineIssue, rankRecommendations } from './recommendation-engine.js';

function issue(over: Partial<EngineIssue>): EngineIssue {
  return {
    code: 'MISSING_TITLE',
    category: 'metadata',
    severity: 'LOW',
    normalizedUrl: 'https://x.com/a',
    title: 'Missing <title>',
    detail: 'no title',
    recommendedFix: 'add a title',
    confidence: 0.9,
    affectedUrlCount: 1,
    evidence: {},
    ...over,
  };
}

describe('rankRecommendations', () => {
  it('publishes the factor weights and severity scale', () => {
    const r = rankRecommendations({ issues: [], pagesCrawled: 10 });
    const w = r.priorityModel.weights;
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(r.priorityModel.severityScale.CRITICAL).toBe(1);
    expect(r.priorityModel.note).toMatch(/not a ranking prediction/i);
  });

  it('priority increases with severity', () => {
    const low = rankRecommendations({
      issues: [issue({ code: 'A', severity: 'LOW' })],
      pagesCrawled: 10,
    }).recommendations[0]!;
    const crit = rankRecommendations({
      issues: [issue({ code: 'A', severity: 'CRITICAL' })],
      pagesCrawled: 10,
    }).recommendations[0]!;
    expect(crit.priorityScore).toBeGreaterThan(low.priorityScore);
  });

  it('priority increases with reach (affected URLs)', () => {
    const narrow = rankRecommendations({
      issues: [issue({ code: 'A', severity: 'MEDIUM', affectedUrlCount: 1 })],
      pagesCrawled: 100,
    }).recommendations[0]!;
    const wide = rankRecommendations({
      issues: [issue({ code: 'A', severity: 'MEDIUM', affectedUrlCount: 90 })],
      pagesCrawled: 100,
    }).recommendations[0]!;
    expect(wide.priorityScore).toBeGreaterThan(narrow.priorityScore);
  });

  it('groups issues by code and sums affected URLs', () => {
    const r = rankRecommendations({
      issues: [
        issue({
          code: 'BROKEN_INTERNAL_LINK',
          normalizedUrl: 'https://x.com/1',
          affectedUrlCount: 2,
        }),
        issue({
          code: 'BROKEN_INTERNAL_LINK',
          normalizedUrl: 'https://x.com/2',
          affectedUrlCount: 3,
        }),
      ],
      pagesCrawled: 20,
    });
    expect(r.recommendations).toHaveLength(1);
    expect(r.recommendations[0]!.evidence.affectedUrlCount).toBe(5);
    expect(r.recommendations[0]!.affectedPages).toEqual(
      expect.arrayContaining(['https://x.com/1', 'https://x.com/2']),
    );
  });

  it('buckets a high-priority easy fix as a quick win', () => {
    const r = rankRecommendations({
      issues: [
        issue({
          code: 'NOINDEX_ON_LINKED_PAGE',
          category: 'indexability',
          severity: 'HIGH',
          affectedUrlCount: 8,
        }),
      ],
      pagesCrawled: 20,
    });
    expect(r.recommendations[0]!.actionPlan).toBe('quick_win');
    expect(r.actionPlans.quickWins).toHaveLength(1);
  });

  it('buckets a hard structural fix as a technical project', () => {
    const r = rankRecommendations({
      issues: [
        issue({
          code: 'CONTENT_REQUIRES_JS',
          category: 'performance',
          severity: 'HIGH',
          affectedUrlCount: 30,
        }),
      ],
      pagesCrawled: 40,
    });
    const rec = r.recommendations[0]!;
    expect(rec.difficulty).toBe('large');
    expect(['technical_project', 'high_impact']).toContain(rec.actionPlan);
  });

  it('every recommendation carries the required fields and no ranking promise', () => {
    const r = rankRecommendations({
      issues: [
        issue({ code: 'MISSING_TITLE', severity: 'HIGH', affectedUrlCount: 4 }),
        issue({
          code: 'HTTP_NOT_HTTPS',
          category: 'security',
          severity: 'HIGH',
          affectedUrlCount: 10,
        }),
      ],
      pagesCrawled: 20,
    });
    for (const rec of r.recommendations) {
      expect(rec.problem).toBeTruthy();
      expect(rec.whyItMatters).toBeTruthy();
      expect(rec.howToFix).toBeTruthy();
      expect(rec.expectedBenefit).toMatch(/not a guarantee of higher search rankings/i);
      expect(['trivial', 'small', 'medium', 'large']).toContain(rec.difficulty);
      expect(rec.confidence).toBeGreaterThan(0);
      expect(rec.priorityScore).toBeGreaterThanOrEqual(0);
      expect(rec.priorityScore).toBeLessThanOrEqual(100);
    }
  });

  it('goal keywords lift business importance for the matching category', () => {
    const base = rankRecommendations({
      issues: [
        issue({
          code: 'ORPHAN_PAGE',
          category: 'architecture',
          severity: 'MEDIUM',
          affectedUrlCount: 5,
        }),
      ],
      pagesCrawled: 20,
    }).recommendations[0]!;
    const boosted = rankRecommendations({
      issues: [
        issue({
          code: 'ORPHAN_PAGE',
          category: 'architecture',
          severity: 'MEDIUM',
          affectedUrlCount: 5,
        }),
      ],
      pagesCrawled: 20,
      goals: ['fix the site structure and navigation hierarchy'],
    }).recommendations[0]!;
    expect(boosted.factors.businessImportance).toBeGreaterThan(base.factors.businessImportance);
    expect(boosted.priorityScore).toBeGreaterThanOrEqual(base.priorityScore);
  });

  it('is deterministic', () => {
    const input = {
      issues: [issue({ code: 'A', severity: 'HIGH', affectedUrlCount: 3 })],
      pagesCrawled: 15,
    };
    expect(JSON.stringify(rankRecommendations(input))).toBe(
      JSON.stringify(rankRecommendations(input)),
    );
  });
});
