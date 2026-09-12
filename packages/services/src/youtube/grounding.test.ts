import { describe, expect, it } from 'vitest';
import type { FactSheet } from './fact-sheet.js';
import { checkGrounding } from './grounding.js';
import { YouTubeAnalysis as YouTubeAnalysisSchema } from './analyst-schema.js';
import type { YouTubeAnalysis } from './analyst-schema.js';

const sheet: FactSheet = {
  channelId: 'UC_x',
  channelTitle: 'Test',
  facts: [
    { id: 'channel.subscribers', label: 'Subscribers', value: 12000, kind: 'fact', origin: 'api' },
    {
      id: 'videos.medianViews',
      label: 'Median views',
      value: 3400,
      kind: 'calculated_metric',
      origin: 'derived',
    },
  ],
  numbers: [12000, 3400],
  videoCountConsidered: 20,
  hasAnalytics: false,
};

function analysis(over: Partial<YouTubeAnalysis> = {}): YouTubeAnalysis {
  return YouTubeAnalysisSchema.parse({
    channelTitle: 'Test',
    dataCoverage: '20 videos, no analytics',
    ...over,
  });
}

describe('checkGrounding', () => {
  it('passes a report that only cites known facts and grounded numbers', () => {
    const a = analysis({
      findings: [
        {
          id: 'f1',
          kind: 'observation',
          title: 'Median views are about 3,400',
          detail: 'Across analyzed videos the median is 3400.',
          evidenceFactIds: ['videos.medianViews'],
          confidence: 0.7,
        },
      ],
    });
    expect(checkGrounding(a, sheet)).toEqual([]);
  });

  it('rejects a citation to an unknown fact id', () => {
    const a = analysis({
      findings: [
        {
          id: 'f1',
          kind: 'opportunity',
          title: 'Something',
          detail: 'Body',
          evidenceFactIds: ['videos.made_up_metric'],
          confidence: 0.5,
        },
      ],
    });
    const issues = checkGrounding(a, sheet);
    expect(issues.some((i) => /unknown fact id/.test(i.problem))).toBe(true);
  });

  it('rejects an ungrounded number in free text', () => {
    const a = analysis({
      recommendations: [
        {
          id: 'r1',
          category: 'titles',
          title: 'Rework titles',
          reasoning: 'Your average watch time is 8 minutes 42 seconds and CTR is 9.7%.',
          suggestedAction: 'Front-load the payoff in the first 5 words.',
          expectedImpact: 'Likely higher click-through.',
          confidence: 0.6,
          effort: 'small',
          priority: 'medium',
          evidenceFactIds: ['videos.medianViews'],
        },
      ],
    });
    const issues = checkGrounding(a, sheet);
    // 8, 42, 5, 9.7 — 8/42/5 are small ints (allowed); 9.7 is not in the sheet.
    expect(issues.some((i) => i.problem.includes('9.7'))).toBe(true);
  });

  it('rejects prohibited guarantee-style phrasing', () => {
    const a = analysis({
      recommendations: [
        {
          id: 'r1',
          category: 'monetization',
          title: 'Apply now',
          reasoning: 'You meet the bar.',
          suggestedAction: 'Apply in Studio.',
          expectedImpact: 'This guarantees monetization approval within a month.',
          confidence: 0.9,
          effort: 'trivial',
          priority: 'high',
          evidenceFactIds: ['channel.subscribers'],
        },
      ],
    });
    const issues = checkGrounding(a, sheet);
    expect(issues.some((i) => /guarantee/.test(i.problem))).toBe(true);
  });
});
