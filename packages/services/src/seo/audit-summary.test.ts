import { describe, expect, it, vi } from 'vitest';
import { SeoAuditGroundingError, runCrawlAuditSummary } from './audit-summary.js';
import { scoreCrawl } from './scoring.js';
import type { CrawlAuditAnalysis } from './analyst-schema.js';

const SCORE = scoreCrawl(
  [
    {
      code: 'MISSING_TITLE',
      category: 'metadata',
      severity: 'HIGH',
      normalizedUrl: 'https://x.com/a',
      title: 'Missing title',
      detail: 'd',
      evidence: {},
      recommendedFix: 'add a title',
      confidence: 0.9,
      affectedUrlCount: 4,
    },
  ],
  10,
);

function fakeDb(opts: { pagesCrawled: number; status?: string }) {
  const created = { agentRun: [] as any[], recommendation: [] as any[], auditLog: [] as any[] };
  const runUpdates: any[] = [];
  return {
    created,
    runUpdates,
    crawl: {
      findFirst: vi.fn(async () => ({
        id: 'crawl_1',
        organizationId: 'org_1',
        websiteId: 'site_1',
        status: opts.status ?? 'COMPLETED',
        pagesCrawled: opts.pagesCrawled,
        scores: SCORE,
        summary: { indexablePages: 8, orphanPages: 1, brokenInternalLinks: 0 },
        website: { id: 'site_1', url: 'https://x.com' },
      })),
    },
    crawlIssue: {
      findMany: vi.fn(async () => [
        {
          code: 'MISSING_TITLE',
          category: 'metadata',
          severity: 'HIGH',
          affectedUrlCount: 4,
          title: 'Missing title',
        },
      ]),
    },
    agentRun: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const row = { id: `run_${created.agentRun.length}`, ...data };
        created.agentRun.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: object }) => {
        runUpdates.push(data);
        return {};
      }),
    },
    recommendation: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const row = { id: `rec_${created.recommendation.length}`, ...data };
        created.recommendation.push(row);
        return row;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

const USAGE = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-5',
  promptTokens: 500,
  completionTokens: 300,
  totalTokens: 800,
  estimatedCostUsd: 0.01,
};

function grounded(): CrawlAuditAnalysis {
  return {
    headline: 'Crawl of https://x.com: metadata gaps to fix',
    overview:
      'The crawl completed with an overall score in the mid range and one high-severity metadata issue.',
    dataCoverage: 'Based on the pages crawled in this run.',
    keyObservations: [
      {
        text: 'A high-severity MISSING_TITLE issue affects several URLs.',
        evidenceFactIds: ['issue_0_MISSING_TITLE', 'issue_0_MISSING_TITLE_count'],
      },
    ],
    prioritizedActions: [
      {
        title: 'Add unique titles to the affected pages',
        rationale: 'The MISSING_TITLE issue is high severity and affects multiple URLs.',
        priority: 'high',
        effort: 'low',
        expectedImpact: 'Improves how those pages are labelled in search and AI answers.',
        recommendedActions: ['Write a descriptive <title> for each affected URL'],
        evidenceFactIds: ['issue_0_MISSING_TITLE'],
      },
    ],
    disclaimers: ['This summary is diagnostic and is not a prediction of ranking changes.'],
  };
}

function hallucinated(): CrawlAuditAnalysis {
  const a = grounded();
  a.keyObservations[0]!.text = 'Organic traffic will increase by 250% once titles are added.';
  a.keyObservations[0]!.evidenceFactIds = ['made_up_fact'];
  return a;
}

describe('runCrawlAuditSummary', () => {
  it('returns a deterministic minimal report for a thin crawl without calling the model', async () => {
    const db = fakeDb({ pagesCrawled: 2 });
    const model = { generateObject: vi.fn() };
    const res = await runCrawlAuditSummary(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        crawlId: 'crawl_1',
      },
    );
    expect(model.generateObject).not.toHaveBeenCalled();
    expect(res.usedModel).toBe(false);
    expect(res.recommendationIds).toHaveLength(0);
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"COMPLETED"');
  });

  it('persists SEO recommendations when the output is grounded', async () => {
    const db = fakeDb({ pagesCrawled: 20 });
    const model = { generateObject: vi.fn(async () => ({ object: grounded(), usage: USAGE })) };
    const res = await runCrawlAuditSummary(
      { db: db as never, model },
      {
        organizationId: 'org_1',
        crawlId: 'crawl_1',
      },
    );
    expect(res.grounded).toBe(true);
    expect(res.recommendationIds).toHaveLength(1);
    expect(db.created.recommendation[0]).toMatchObject({ domain: 'SEO' });
  });

  it('rejects hallucinated output after a repair attempt and fails the run', async () => {
    const db = fakeDb({ pagesCrawled: 20 });
    const model = { generateObject: vi.fn(async () => ({ object: hallucinated(), usage: USAGE })) };
    await expect(
      runCrawlAuditSummary(
        { db: db as never, model },
        { organizationId: 'org_1', crawlId: 'crawl_1' },
      ),
    ).rejects.toBeInstanceOf(SeoAuditGroundingError);
    expect(model.generateObject).toHaveBeenCalledTimes(2);
    expect(db.created.recommendation).toHaveLength(0);
    expect(JSON.stringify(db.runUpdates)).toContain('"status":"FAILED"');
  });
});
