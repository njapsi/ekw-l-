import { describe, expect, it, vi } from 'vitest';
import { buildReportSnapshot } from './build.js';
import { sampleSnapshot } from './sample.js';

function recRow(id: string, priority: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: 'org_1',
    domain: 'SEO',
    title: `Rec ${id}`,
    explanation: 'why it matters',
    reasoning: 'reasoning',
    priority,
    effort: 'small',
    confidence: 0.8,
    expectedImpact: 'better',
    recommendedActions: ['do a', 'do b'],
    implementationInstructions: 'steps',
    status: 'PROPOSED',
    updatedAt: new Date('2026-09-07'),
    createdAt: new Date('2026-09-01'),
    ...over,
  };
}

function makeDb(recs: unknown[]) {
  return {
    recommendation: { findMany: vi.fn(async () => recs) },
  };
}

describe('buildReportSnapshot — AI_RECOMMENDATIONS', () => {
  it('assembles all seven sections with correct meta', async () => {
    const db = makeDb([
      recRow('a', 'critical'),
      recRow('b', 'high'),
      recRow('c', 'medium'),
      recRow('d', 'low', { status: 'APPLIED' }), // not open
    ]);
    const { snapshot, connected } = await buildReportSnapshot(
      { organizationId: 'org_1', orgName: 'Acme Inc', type: 'AI_RECOMMENDATIONS' },
      { db: db as never },
    );
    expect(connected).toBe(true);
    expect(snapshot.meta).toMatchObject({ type: 'AI_RECOMMENDATIONS', orgName: 'Acme Inc' });
    expect(snapshot.meta.title).toMatch(/AI recommendations/i);
    // seven sections present
    expect(snapshot.executiveSummary.paragraphs.length).toBeGreaterThan(0);
    expect(snapshot.keyMetrics.length).toBeGreaterThan(0);
    expect(snapshot.problems.length).toBeGreaterThan(0); // critical + high surface as problems
    expect(Array.isArray(snapshot.opportunities)).toBe(true);
    expect(snapshot.recommendations).toHaveLength(3); // open only
    expect(snapshot.priorityActions[0]?.title).toBe('Rec a'); // critical first
    expect(snapshot.historicalChanges.comparedTo).toBeNull();
    expect(snapshot.disclaimers.length).toBeGreaterThan(0);
  });

  it('populates Historical Changes when a previous snapshot is supplied', async () => {
    const db = makeDb([recRow('a', 'critical'), recRow('b', 'high')]);
    const previousSnap = sampleSnapshot({
      meta: { ...sampleSnapshot().meta, type: 'AI_RECOMMENDATIONS' },
      keyMetrics: [
        { label: 'Open recommendations', value: '5', raw: 5, delta: null },
        { label: 'Critical', value: '0', raw: 0, delta: null },
      ],
    });
    const { snapshot } = await buildReportSnapshot(
      {
        organizationId: 'org_1',
        orgName: 'Acme Inc',
        type: 'AI_RECOMMENDATIONS',
        previous: {
          reportId: 'rep_prev',
          generatedAt: '2026-08-01T00:00:00.000Z',
          snapshot: previousSnap,
        },
      },
      { db: db as never },
    );
    expect(snapshot.historicalChanges.comparedTo?.reportId).toBe('rep_prev');
    const openChange = snapshot.historicalChanges.changes.find(
      (c) => c.label === 'Open recommendations',
    );
    expect(openChange).toMatchObject({ from: '5', to: '2', direction: 'down' });
    const openMetric = snapshot.keyMetrics.find((m) => m.label === 'Open recommendations');
    expect(openMetric?.delta).toMatchObject({ previous: '5', direction: 'down' });
  });

  it('marks the report not-connected with a data gap when there are no recommendations', async () => {
    const { snapshot, connected } = await buildReportSnapshot(
      { organizationId: 'org_1', orgName: 'Acme Inc', type: 'AI_RECOMMENDATIONS' },
      { db: makeDb([]) as never },
    );
    expect(connected).toBe(false);
    expect(snapshot.dataGaps.length).toBeGreaterThan(0);
    expect(snapshot.executiveSummary.headline).toMatch(/not enough data/i);
  });
});
