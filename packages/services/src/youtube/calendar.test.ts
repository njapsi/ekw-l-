import { describe, expect, it } from 'vitest';
import { generateCalendarDrafts } from './calendar.js';
import type { YouTubeOpportunityDraft } from './opportunities.js';

function opportunity(overrides: Partial<YouTubeOpportunityDraft> = {}): YouTubeOpportunityDraft {
  return {
    type: 'CONTENT_EXPANSION',
    title: 'Expand topic X',
    description: 'Evidence-backed description.',
    evidence: [],
    factors: {
      evidenceStrength: 0.8,
      historicalPerformance: 0.8,
      contentGap: 0.5,
      executionFeasibility: 0.7,
    },
    priorityScore: 0.7,
    confidence: 'HIGH',
    recommendedActions: [],
    relatedVideoIds: [],
    ...overrides,
  };
}

describe('generateCalendarDrafts', () => {
  it('produces cadencePerWeek * weeks slots', () => {
    const drafts = generateCalendarDrafts({
      opportunities: [opportunity()],
      cadencePerWeek: 2,
      weeks: 4,
      startDate: new Date('2026-01-01'),
    });
    expect(drafts).toHaveLength(8);
  });

  it('cycles through opportunities rather than repeating only the first', () => {
    const opps = [
      opportunity({ title: 'A' }),
      opportunity({ title: 'B' }),
      opportunity({ title: 'C' }),
    ];
    const drafts = generateCalendarDrafts({
      opportunities: opps,
      cadencePerWeek: 3,
      weeks: 1,
      startDate: new Date('2026-01-01'),
    });
    expect(drafts.map((d) => d.title)).toEqual(['A', 'B', 'C']);
  });

  it('falls back to an honest "not yet assigned" slot when there are no opportunities — never fabricates a topic', () => {
    const drafts = generateCalendarDrafts({
      opportunities: [],
      cadencePerWeek: 1,
      weeks: 1,
      startDate: new Date('2026-01-01'),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toContain('not yet assigned');
    expect(drafts[0]!.sourceOpportunityType).toBeNull();
  });

  it('marks a SHORTS_OPPORTUNITY-derived slot as short format, others as long_form', () => {
    const drafts = generateCalendarDrafts({
      opportunities: [
        opportunity({ type: 'SHORTS_OPPORTUNITY' }),
        opportunity({ type: 'CONTENT_EXPANSION' }),
      ],
      cadencePerWeek: 2,
      weeks: 1,
      startDate: new Date('2026-01-01'),
    });
    expect(drafts[0]!.format).toBe('short');
    expect(drafts[1]!.format).toBe('long_form');
  });

  it('spreads dates evenly across the requested window, never scheduling in the past relative to startDate', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const drafts = generateCalendarDrafts({
      opportunities: [opportunity()],
      cadencePerWeek: 2,
      weeks: 2,
      startDate: start,
    });
    for (const d of drafts) {
      expect(d.scheduledDate.getTime()).toBeGreaterThanOrEqual(start.getTime());
    }
    // Dates should be non-decreasing.
    for (let i = 1; i < drafts.length; i++) {
      expect(drafts[i]!.scheduledDate.getTime()).toBeGreaterThanOrEqual(
        drafts[i - 1]!.scheduledDate.getTime(),
      );
    }
  });

  it('returns no drafts for a zero cadence', () => {
    expect(
      generateCalendarDrafts({
        opportunities: [],
        cadencePerWeek: 0,
        weeks: 4,
        startDate: new Date(),
      }),
    ).toEqual([]);
  });
});
