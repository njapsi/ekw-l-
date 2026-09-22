import { beforeEach, describe, expect, it, vi } from 'vitest';

type AnyFn = (...a: unknown[]) => Promise<unknown>;

const runYouTubeAnalystJob = vi.fn<AnyFn>(() => Promise.resolve({ agentRunId: 'ar_yt' }));
const runTikTokAnalystJob = vi.fn<AnyFn>(() => Promise.resolve({ agentRunId: 'ar_tt' }));
const runMonetizationScanJob = vi.fn<AnyFn>(() =>
  Promise.resolve({ agentRunId: 'ar_mn', opportunities: [1, 2] }),
);
const generateReportJob = vi.fn<AnyFn>(() =>
  Promise.resolve({ status: 'READY', reportId: 'rep_1' }),
);
const runGrowthAgentTurnJob = vi.fn<AnyFn>(() =>
  Promise.resolve({
    agentRunId: 'ar_ga',
    conversationId: 'conv_1',
    blocks: {
      recommendations: [
        {
          title: 'Do a series on X',
          problem: 'p',
          whyItMatters: 'w',
          howToFix: 'h',
          expectedBenefit: 'b',
          priority: 'high',
          difficulty: 'small',
          confidence: 0.8,
          domain: 'CONTENT',
          affectedUrls: [],
          affectedRefs: [],
        },
      ],
    },
  }),
);
const startCrawl = vi.fn<AnyFn>(() =>
  Promise.resolve({
    crawlId: 'crawl_1',
    result: { status: 'COMPLETED', pagesCrawled: 10, issuesFound: 2 },
  }),
);
const getPrimaryChannel = vi.fn<AnyFn>(() => Promise.resolve({ id: 'ch_1', title: 'My Channel' }));
const getPrimaryAccount = vi.fn<AnyFn>(() =>
  Promise.resolve({ id: 'acc_1', displayName: 'My TT' }),
);
const listWebsites = vi.fn<AnyFn>(() =>
  Promise.resolve([{ id: 'site_1', hostname: 'example.com', verified: true }]),
);
const getCrawlOverview = vi.fn<AnyFn>(() =>
  Promise.resolve({
    crawl: { website: { hostname: 'example.com' } },
    issues: { bySeverity: { CRITICAL: 2 } },
  }),
);
const createTask = vi.fn<AnyFn>(() => Promise.resolve({ id: 'task_1', title: 't' }));

vi.mock('../youtube/jobs.js', () => ({ runYouTubeAnalystJob }));
vi.mock('../youtube/read.js', () => ({ getPrimaryChannel }));
vi.mock('../tiktok/jobs.js', () => ({ runTikTokAnalystJob }));
vi.mock('../tiktok/read.js', () => ({ getPrimaryAccount }));
vi.mock('../monetization/jobs.js', () => ({ runMonetizationScanJob }));
vi.mock('../reports/jobs.js', () => ({ generateReportJob }));
vi.mock('../agent/jobs.js', () => ({ runGrowthAgentTurnJob }));
vi.mock('../agent/tasks.js', () => ({ createTask }));
vi.mock('../seo/jobs.js', () => ({ startCrawl }));
vi.mock('../seo/read.js', () => ({ listWebsites, getCrawlOverview }));

const { dispatchTask } = await import('./dispatch.js');

function makeDb(over: Partial<Record<string, unknown>> = {}) {
  return {
    crawl: { findFirst: vi.fn(async () => ({ id: 'crawl_1' })) },
    crawlIssue: {
      findMany: vi.fn(async () => [
        { severity: 'CRITICAL', code: 'X', recommendedFix: 'fix', detail: 'd' },
      ]),
    },
    task: { findFirst: vi.fn(async () => null) },
    youTubeMetric: { findMany: vi.fn(async () => []) },
    tikTokMetric: { findMany: vi.fn(async () => []) },
    notification: {
      create: vi.fn(async () => ({ id: 'n1' })),
      upsert: vi.fn(async () => ({ id: 'n1' })),
    },
    ...over,
  } as never;
}

const ctx = {
  organizationId: 'org1',
  ownerId: 'owner1',
  ruleId: 'rule_1',
  runId: 'run_1',
  config: {},
};

beforeEach(() => {
  for (const m of [
    runYouTubeAnalystJob,
    runTikTokAnalystJob,
    runMonetizationScanJob,
    generateReportJob,
    runGrowthAgentTurnJob,
    startCrawl,
    createTask,
  ]) {
    m.mockClear();
  }
});

describe('dispatchTask routing', () => {
  it('YOUTUBE_ANALYSIS → runYouTubeAnalystJob with the internal channel id', async () => {
    const r = await dispatchTask('YOUTUBE_ANALYSIS', ctx, makeDb());
    expect(runYouTubeAnalystJob).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'ch_1', trigger: 'automation' }),
      expect.anything(),
    );
    expect(r.summary).toMatch(/My Channel/);
  });

  it('TIKTOK_ANALYSIS → runTikTokAnalystJob with the internal account id', async () => {
    await dispatchTask('TIKTOK_ANALYSIS', ctx, makeDb());
    expect(runTikTokAnalystJob).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc_1' }),
      expect.anything(),
    );
  });

  it('TIKTOK_ANALYSIS also runs anomaly detection and notifies on a clear follower spike', async () => {
    const upsert = vi.fn<AnyFn>(async () => ({ id: 'n1', emailedAt: null }));
    let followers = 1000;
    const snapshots = Array.from({ length: 16 }, (_, i) => {
      const date = new Date('2026-01-01T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + i);
      if (i > 0) followers += i % 2 === 0 ? 8 : 12;
      return {
        capturedAt: date,
        followerCount: BigInt(followers),
        likesCount: BigInt(5000 + i * 50),
      };
    });
    const last = snapshots[snapshots.length - 1]!;
    snapshots[snapshots.length - 1] = { ...last, followerCount: last.followerCount + 100_000n };
    const r = await dispatchTask(
      'TIKTOK_ANALYSIS',
      ctx,
      makeDb({
        tikTokMetric: { findMany: vi.fn(async () => snapshots) },
        notification: { upsert, create: vi.fn() },
      }),
    );
    expect(upsert).toHaveBeenCalled();
    const call = upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(call.create.kind).toBe('tiktok.anomaly_detected');
    expect(call.create.level).toMatch(/WARNING|CRITICAL/);
    expect((r.detail as { anomaliesDetected: number }).anomaliesDetected).toBeGreaterThan(0);
  });

  it('YOUTUBE_ANALYSIS also runs anomaly detection and notifies on a clear spike', async () => {
    const upsert = vi.fn<AnyFn>(async () => ({ id: 'n1', emailedAt: null }));
    const dailyRows = Array.from({ length: 14 }, (_, i) => {
      const date = new Date('2026-01-01T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + i);
      return {
        date,
        views: BigInt(1000 + (i % 2 === 0 ? 20 : -20)),
        estimatedMinutesWatched: 5000n,
        likes: 50n,
        comments: 10n,
        shares: 5n,
        subscribersGained: 20n,
        subscribersLost: 5n,
        estimatedRevenue: null,
      };
    });
    dailyRows.push({
      date: new Date('2026-01-15T00:00:00Z'),
      views: 100_000n,
      estimatedMinutesWatched: 5000n,
      likes: 50n,
      comments: 10n,
      shares: 5n,
      subscribersGained: 20n,
      subscribersLost: 5n,
      estimatedRevenue: null,
    });
    const r = await dispatchTask(
      'YOUTUBE_ANALYSIS',
      ctx,
      makeDb({
        youTubeMetric: { findMany: vi.fn(async () => dailyRows) },
        notification: { upsert, create: vi.fn() },
      }),
    );
    expect(upsert).toHaveBeenCalled();
    const call = upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(call.create.kind).toBe('youtube.anomaly_detected');
    expect(call.create.level).toMatch(/WARNING|CRITICAL/);
    expect((r.detail as { anomaliesDetected: number }).anomaliesDetected).toBeGreaterThan(0);
  });

  it('WEBSITE_CRAWL → startCrawl on the verified website', async () => {
    const r = await dispatchTask('WEBSITE_CRAWL', ctx, makeDb());
    expect(startCrawl).toHaveBeenCalledWith(
      expect.objectContaining({ websiteId: 'site_1', userId: 'owner1' }),
      expect.anything(),
    );
    expect(r.detail?.crawlId).toBe('crawl_1');
  });

  it('MONETIZATION_SCAN → runMonetizationScanJob', async () => {
    const r = await dispatchTask('MONETIZATION_SCAN', ctx, makeDb());
    expect(runMonetizationScanJob).toHaveBeenCalled();
    expect(r.summary).toMatch(/2 opportunities/);
  });

  it('GROWTH_REPORT → generateReportJob with the configured type', async () => {
    await dispatchTask(
      'GROWTH_REPORT',
      { ...ctx, config: { reportType: 'SEO', websiteId: 'site_1' } },
      makeDb(),
    );
    expect(generateReportJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SEO', params: { websiteId: 'site_1' } }),
      expect.anything(),
    );
  });

  it('GROWTH_REPORT throws when the report fails', async () => {
    generateReportJob.mockResolvedValueOnce({
      status: 'FAILED',
      reportId: 'x',
      error: 'nope',
    } as never);
    await expect(dispatchTask('GROWTH_REPORT', ctx, makeDb())).rejects.toThrow(/nope/);
  });
});

describe('SEO_ISSUE_ALERT', () => {
  it('opens a task when a new critical issue is present', async () => {
    const r = await dispatchTask('SEO_ISSUE_ALERT', ctx, makeDb());
    expect(createTask).toHaveBeenCalledOnce();
    expect(r.summary).toMatch(/Opened a task/);
    expect((createTask.mock.calls[0]![0] as { affectedRefs: string[] }).affectedRefs).toContain(
      'crawl:crawl_1',
    );
  });

  it('does not re-open a task for a crawl that already produced one', async () => {
    const db = makeDb({ task: { findFirst: vi.fn(async () => ({ id: 'existing' })) } });
    const r = await dispatchTask('SEO_ISSUE_ALERT', ctx, db);
    expect(createTask).not.toHaveBeenCalled();
    expect(r.summary).toMatch(/already opened/);
  });

  it('reports "no issues" when the latest crawl is clean', async () => {
    getCrawlOverview.mockResolvedValueOnce({
      crawl: { website: { hostname: 'example.com' } },
      issues: { bySeverity: {} },
    } as never);
    const r = await dispatchTask('SEO_ISSUE_ALERT', ctx, makeDb());
    expect(createTask).not.toHaveBeenCalled();
    expect(r.summary).toMatch(/No critical SEO issues/);
  });
});

describe('CONTENT_OPPORTUNITY', () => {
  it('runs one agent turn and opens a task from the top recommendation', async () => {
    const r = await dispatchTask('CONTENT_OPPORTUNITY', ctx, makeDb());
    expect(runGrowthAgentTurnJob).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Do a series on X'),
        sourceConversationId: 'conv_1',
      }),
      expect.anything(),
    );
    expect(r.detail?.taskId).toBe('task_1');
  });
});
