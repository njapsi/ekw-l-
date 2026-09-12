import { describe, expect, it, vi } from 'vitest';
import type { GatheredReport } from './schemas.js';
import { assembleSections } from './sections.js';
import { buildExecutiveSummary } from './summary.js';

function gathered(over: Partial<GatheredReport> = {}): GatheredReport {
  return {
    connected: true,
    subjectLabel: 'Acme Channel',
    subjectRef: 'ch_1',
    dataThrough: new Date('2026-09-07'),
    periodStart: null,
    periodEnd: null,
    metrics: [{ key: 'subs', label: 'Subscribers', value: '12,300', raw: 12300 }],
    problems: [
      { id: 'p', title: 'Analytics not synced', detail: 'x', severity: 'medium', evidence: [] },
    ],
    opportunities: [],
    recommendations: [
      {
        id: 'r',
        title: 'Post more consistently',
        why: 'cadence is irregular',
        actions: ['schedule uploads'],
        priority: 'high',
        effort: 'small',
        confidence: 0.7,
        expectedImpact: 'steadier growth',
      },
    ],
    facts: [{ id: 'f1', text: 'YouTube channel "Acme Channel" has 12,300 subscribers.' }],
    dataGaps: [],
    disclaimers: [],
    ...over,
  };
}

const base = { type: 'YOUTUBE' as const, subjectLabel: 'Acme Channel' };

describe('buildExecutiveSummary', () => {
  it('produces a deterministic summary with no model', async () => {
    const g = gathered();
    const s = assembleSections(g, null, null);
    const out = await buildExecutiveSummary({ ...base, gathered: g, sections: s }, {});
    expect(out.grounded).toBe(false);
    expect(out.headline).toMatch(/Acme Channel/);
    expect(out.paragraphs.length).toBeGreaterThanOrEqual(2);
  });

  it('reports "not enough data" when the source is not connected', async () => {
    const g = gathered({ connected: false, dataGaps: ['No YouTube channel is connected.'] });
    const s = assembleSections(g, null, null);
    const out = await buildExecutiveSummary({ ...base, gathered: g, sections: s }, {});
    expect(out.headline).toMatch(/not enough data/i);
  });

  it('adopts a grounded model summary when it passes the grounding check', async () => {
    const g = gathered();
    const s = assembleSections(g, null, null);
    const model = {
      generateObject: vi.fn(async () => ({
        object: {
          headline: 'Acme Channel is growing steadily',
          paragraphs: ['The channel has 12,300 subscribers.', 'One issue needs attention.'],
          evidenceRefs: ['f1'],
        },
        usage: {
          provider: 'x',
          model: 'y',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0,
        },
      })),
    };
    const out = await buildExecutiveSummary(
      { ...base, gathered: g, sections: s },
      { model: model as never },
    );
    expect(out.grounded).toBe(true);
    expect(out.headline).toBe('Acme Channel is growing steadily');
  });

  it('drops a model summary that cites an unknown fact or states an ungrounded number', async () => {
    const g = gathered();
    const s = assembleSections(g, null, null);
    const model = {
      generateObject: vi.fn(async () => ({
        object: {
          headline: 'Massive growth ahead',
          paragraphs: ['The channel will reach 999999 subscribers next month, guaranteed.'],
          evidenceRefs: ['f9'],
        },
        usage: {
          provider: 'x',
          model: 'y',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0,
        },
      })),
    };
    const out = await buildExecutiveSummary(
      { ...base, gathered: g, sections: s },
      { model: model as never },
    );
    expect(out.grounded).toBe(false);
    expect(out.headline).not.toMatch(/massive growth/i);
  });

  it('falls back cleanly when the model throws', async () => {
    const g = gathered();
    const s = assembleSections(g, null, null);
    const model = {
      generateObject: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const out = await buildExecutiveSummary(
      { ...base, gathered: g, sections: s },
      { model: model as never },
    );
    expect(out.grounded).toBe(false);
  });
});
