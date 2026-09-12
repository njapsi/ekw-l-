import { describe, expect, it } from 'vitest';
import type { GatheredReport } from './schemas.js';
import { sampleSnapshot } from './sample.js';
import { assembleSections, buildHistoricalChanges, buildKeyMetrics } from './sections.js';

function gathered(over: Partial<GatheredReport> = {}): GatheredReport {
  return {
    connected: true,
    subjectLabel: 'Acme',
    subjectRef: 'ch_1',
    dataThrough: new Date('2026-09-07'),
    periodStart: null,
    periodEnd: null,
    metrics: [
      { key: 'subs', label: 'Subscribers', value: '12.3K', raw: 12300 },
      { key: 'views', label: 'Views (28d)', value: '100,000', raw: 100000 },
    ],
    problems: [
      { id: 'a', title: 'Low sev', detail: 'x', severity: 'low', evidence: [] },
      { id: 'b', title: 'Critical', detail: 'x', severity: 'critical', evidence: [] },
      { id: 'c', title: 'Medium', detail: 'x', severity: 'medium', evidence: [] },
    ],
    opportunities: [],
    recommendations: [
      recc('r-med', 'medium', 0.9),
      recc('r-crit', 'critical', 0.5),
      recc('r-high', 'high', 0.7),
    ],
    facts: [],
    dataGaps: [],
    disclaimers: [],
    ...over,
  };
}

function recc(id: string, priority: 'critical' | 'high' | 'medium' | 'low', confidence: number) {
  return {
    id,
    title: `Rec ${id}`,
    why: 'because',
    actions: ['do it'],
    priority,
    effort: 'small' as const,
    confidence,
    expectedImpact: 'impact',
  };
}

describe('buildKeyMetrics', () => {
  it('computes a delta + direction against the previous snapshot (matched by label)', () => {
    const prev = sampleSnapshot({
      keyMetrics: [{ label: 'Subscribers', value: '10.0K', raw: 10000, delta: null }],
    });
    const [subs, views] = buildKeyMetrics(gathered().metrics, prev);
    expect(subs?.delta).toMatchObject({ previous: '10.0K', direction: 'up' });
    expect(subs?.delta?.changePct).toBe(23); // (12300-10000)/10000
    expect(views?.delta).toBeNull(); // no previous entry for this label
  });

  it('has no delta when there is no previous snapshot', () => {
    for (const m of buildKeyMetrics(gathered().metrics, null)) expect(m.delta).toBeNull();
  });

  it('computes an exact negative percentage change and a "down" direction', () => {
    const g = gathered({
      metrics: [{ key: 'subs', label: 'Subscribers', value: '8.0K', raw: 8000 }],
    });
    const prev = sampleSnapshot({
      keyMetrics: [{ label: 'Subscribers', value: '10.0K', raw: 10000, delta: null }],
    });
    const [subs] = buildKeyMetrics(g.metrics, prev);
    expect(subs?.delta?.changePct).toBe(-20); // (8000-10000)/10000 * 100
    expect(subs?.delta?.direction).toBe('down');
  });

  it('treats a sub-0.5% move as "flat" rather than up/down', () => {
    const g = gathered({
      metrics: [{ key: 'subs', label: 'Subscribers', value: '10,020', raw: 10020 }],
    });
    const prev = sampleSnapshot({
      keyMetrics: [{ label: 'Subscribers', value: '10,000', raw: 10000, delta: null }],
    });
    const [subs] = buildKeyMetrics(g.metrics, prev);
    expect(subs?.delta?.changePct).toBe(0.2); // (10020-10000)/10000 * 100
    expect(subs?.delta?.direction).toBe('flat');
  });
});

describe('buildHistoricalChanges', () => {
  it('is empty with a helpful note on the first report', () => {
    const hc = buildHistoricalChanges(gathered().metrics, null, null);
    expect(hc.comparedTo).toBeNull();
    expect(hc.changes).toHaveLength(0);
    expect(hc.notes[0]).toMatch(/first report/i);
  });

  it('lists only the metrics whose value changed', () => {
    const prev = sampleSnapshot({
      keyMetrics: [
        { label: 'Subscribers', value: '10.0K', raw: 10000, delta: null },
        { label: 'Views (28d)', value: '100,000', raw: 100000, delta: null },
      ],
    });
    const hc = buildHistoricalChanges(gathered().metrics, prev, {
      reportId: 'prev',
      generatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(hc.comparedTo?.reportId).toBe('prev');
    expect(hc.changes.map((c) => c.label)).toEqual(['Subscribers']);
    expect(hc.changes[0]?.direction).toBe('up');
  });
});

describe('assembleSections', () => {
  it('sorts problems by severity and ranks the top recommendations as priority actions', () => {
    const s = assembleSections(gathered(), null, null);
    expect(s.problems.map((p) => p.severity)).toEqual(['critical', 'medium', 'low']);
    expect(s.priorityActions[0]?.title).toBe('Rec r-crit');
    expect(s.priorityActions[1]?.title).toBe('Rec r-high');
    expect(s.priorityActions.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(s.recommendations[0]?.priority).toBe('critical');
  });
});
