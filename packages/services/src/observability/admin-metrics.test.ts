import { describe, expect, it, vi } from 'vitest';
import { aiUsageSummary, crawlerSummary, jobDurationSummary } from './admin-metrics.js';

describe('aiUsageSummary', () => {
  it('aggregates tokens, cost, failure rate and latency percentiles', async () => {
    const now = Date.now();
    const db = {
      agentRun: {
        aggregate: vi.fn(async () => ({
          _count: { _all: 10 },
          _sum: { tokensPrompt: 1000, tokensCompletion: 400, costUsd: 0.5 },
        })),
        groupBy: vi.fn(async ({ by }: any) => {
          if (by[0] === 'provider')
            return [{ provider: 'anthropic', _count: { _all: 10 }, _sum: { costUsd: 0.5 } }];
          if (by[0] === 'model')
            return [
              {
                model: 'claude',
                _count: { _all: 10 },
                _sum: { tokensPrompt: 1000, tokensCompletion: 400, costUsd: 0.5 },
              },
            ];
          if (by[0] === 'agent')
            return [{ agent: 'growth', _count: { _all: 10 }, _sum: { costUsd: 0.5 } }];
          if (by[0] === 'status')
            return [
              { status: 'COMPLETED', _count: { _all: 8 } },
              { status: 'FAILED', _count: { _all: 2 } },
            ];
          return [];
        }),
        findMany: vi.fn(async () =>
          Array.from({ length: 10 }, (_, i) => ({
            startedAt: new Date(now - 1000 * (i + 1)),
            finishedAt: new Date(now - 1000 * (i + 1) + (i < 9 ? 200 : 5000)),
          })),
        ),
      },
    } as any;

    const s = await aiUsageSummary(db, { sinceMs: 60_000 });
    expect(s.runs).toBe(10);
    expect(s.failed).toBe(2);
    expect(s.failureRate).toBeCloseTo(0.2);
    expect(s.promptTokens).toBe(1000);
    expect(s.completionTokens).toBe(400);
    expect(s.costUsd).toBeCloseTo(0.5);
    expect(s.latencyMs.p50).toBeLessThan(1000);
    expect(s.latencyMs.p95).toBeGreaterThanOrEqual(1000);
    expect(s.byProvider[0]).toMatchObject({ provider: 'anthropic', runs: 10 });
  });
});

describe('crawlerSummary', () => {
  it('computes the failure rate and totals', async () => {
    const db = {
      crawl: {
        groupBy: vi.fn(async () => [
          { status: 'COMPLETED', _count: { _all: 7 } },
          { status: 'FAILED', _count: { _all: 3 } },
        ]),
        aggregate: vi.fn(async () => ({
          _count: { _all: 10 },
          _sum: { pagesCrawled: 250, issuesFound: 40 },
        })),
        findMany: vi.fn(async () => [
          { startedAt: new Date(0), finishedAt: new Date(5_000) },
          { startedAt: new Date(0), finishedAt: new Date(15_000) },
        ]),
      },
    } as any;
    const s = await crawlerSummary(db, { sinceMs: 60_000 });
    expect(s.total).toBe(10);
    expect(s.failed).toBe(3);
    expect(s.failureRate).toBeCloseTo(0.3);
    expect(s.pagesCrawled).toBe(250);
    expect(s.durationMs.p95).toBeGreaterThanOrEqual(5_000);
  });
});

describe('jobDurationSummary', () => {
  it('summarises automation-run durations and tolerates an unreachable Redis', async () => {
    const db = {
      automationRun: {
        groupBy: vi.fn(async () => [{ status: 'SUCCEEDED', _count: { _all: 5 } }]),
        findMany: vi.fn(async () => [
          { durationMs: 100 },
          { durationMs: 200 },
          { durationMs: 900 },
        ]),
      },
    } as any;
    const s = await jobDurationSummary(db, { sinceMs: 60_000 });
    expect(s.automationRuns.byStatus[0]).toMatchObject({ status: 'SUCCEEDED', count: 5 });
    expect(s.automationRuns.durationMs.p50).toBeGreaterThan(0);
    expect(Array.isArray(s.queues)).toBe(true);
    expect(typeof s.totalDepth).toBe('number');
  });
});
