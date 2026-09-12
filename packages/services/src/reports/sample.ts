/**
 * A representative `ReportSnapshot` used by tests and available as a reference
 * shape. Not used at runtime.
 */
import type { ReportSnapshot } from '@growth-agent/core';

export function sampleSnapshot(over: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    version: 1,
    meta: {
      type: 'YOUTUBE',
      title: 'YouTube performance — Acme Channel',
      subjectLabel: 'Acme Channel',
      orgName: 'Acme Inc',
      generatedAt: '2026-09-08T12:00:00.000Z',
      periodStart: null,
      periodEnd: null,
      dataThrough: '2026-09-07T00:00:00.000Z',
      isPublic: false,
    },
    executiveSummary: {
      headline: 'YouTube performance for Acme Channel',
      paragraphs: [
        'Key metrics: Subscribers 12.3K, Total views 4.5M.',
        'One issue was identified. 2 recommendations are open.',
        'Since the previous report, Subscribers moved from 11,900 to 12,300.',
      ],
      grounded: false,
    },
    keyMetrics: [
      {
        label: 'Subscribers',
        value: '12.3K',
        raw: 12300,
        unit: undefined,
        delta: { previous: '11.9K', changePct: 3.4, direction: 'up' },
        note: undefined,
      },
      {
        label: 'Recorded revenue',
        value: '$1,234 USD',
        raw: 1234,
        delta: { previous: '$1,000 USD', changePct: 23.4, direction: 'up' },
        note: 'User-entered only.',
      },
    ],
    problems: [
      {
        id: 'p1',
        title: 'Analytics not synced',
        detail: 'Visit https://studio.youtube.com to reconnect. Contact ops@acme.com if it fails.',
        severity: 'medium',
        evidence: ['Affected URLs: 3'],
      },
    ],
    opportunities: [
      {
        id: 'o1',
        title: 'Double down on your strongest theme (#tutorials)',
        detail: 'Your top theme "#tutorials" spans 12 videos.',
        potential: 'High (estimate)',
        effort: 'small',
      },
    ],
    recommendations: [
      {
        id: 'r1',
        title: 'Fix canonical tags on paginated pages',
        why: 'Search engines are indexing duplicate URLs from example.com/blog?page=2.',
        actions: ['Add rel=canonical', 'Verify in Search Console at https://search.google.com'],
        priority: 'high',
        effort: 'small',
        confidence: 0.8,
        expectedImpact: 'Cleaner indexation.',
      },
    ],
    priorityActions: [
      {
        rank: 1,
        title: 'Fix canonical tags on paginated pages',
        rationale: 'Search engines are indexing duplicate URLs from example.com/blog?page=2.',
        effort: 'small',
      },
    ],
    historicalChanges: {
      comparedTo: { reportId: 'rep_prev', generatedAt: '2026-08-08T12:00:00.000Z' },
      changes: [
        { label: 'Subscribers', from: '11.9K', to: '12.3K', changePct: 3.4, direction: 'up' },
        {
          label: 'Recorded revenue',
          from: '$1,000 USD',
          to: '$1,234 USD',
          changePct: 23.4,
          direction: 'up',
        },
      ],
      notes: [],
    },
    disclaimers: ['This report never guarantees outcomes.'],
    dataGaps: ['YouTube Analytics has not been synced.'],
    ...over,
  };
}
