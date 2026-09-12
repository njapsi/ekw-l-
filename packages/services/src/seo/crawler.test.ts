/**
 * Fast, DB-free unit tests for the two `finalize()` persistence helpers
 * extracted in Phase 28 (performance pass). `crawler.integration.test.ts`
 * exercises the full `runCrawl` pipeline against a real Postgres and is
 * gated on `TEST_DATABASE_URL`; these tests cover the same write behavior
 * (correct arguments, bounded concurrency, one bad row doesn't abort the
 * batch) with a fake `Db`, so they run everywhere.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PageRecord } from './page-eval.js';
import type { IssueDraft } from './rules.js';
import { type CrawlRow, persistCrawlIssues, persistInboundLinkCounts } from './crawler.js';

function fakePages(urls: string[]): PageRecord[] {
  return urls.map((normalizedUrl) => ({ normalizedUrl }) as unknown as PageRecord);
}

function fakeIssue(overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    code: 'missing-title',
    category: 'metadata',
    severity: 'MEDIUM',
    normalizedUrl: 'https://example.test/page',
    title: 'Missing title',
    detail: 'The page has no <title>.',
    evidence: {},
    recommendedFix: 'Add a descriptive <title>.',
    confidence: 1,
    affectedUrlCount: 1,
    ...overrides,
  };
}

describe('persistInboundLinkCounts', () => {
  it('writes the graph-computed inbound count for each page, 0 when absent from the map', async () => {
    const update = vi.fn(async () => ({}));
    const db = { crawlPage: { update } } as any;
    const pages = fakePages(['https://a.test/', 'https://b.test/', 'https://c.test/']);
    const inboundCountByUrl = new Map([
      ['https://a.test/', 3],
      ['https://b.test/', 0],
    ]);

    await persistInboundLinkCounts(db, 'crawl1', pages, inboundCountByUrl);

    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledWith({
      where: { crawlId_normalizedUrl: { crawlId: 'crawl1', normalizedUrl: 'https://a.test/' } },
      data: { inboundInternalCount: 3 },
    });
    expect(update).toHaveBeenCalledWith({
      where: { crawlId_normalizedUrl: { crawlId: 'crawl1', normalizedUrl: 'https://c.test/' } },
      data: { inboundInternalCount: 0 },
    });
  });

  it('does not abort the batch when one write rejects', async () => {
    const update = vi.fn(
      async (args: { where: { crawlId_normalizedUrl: { normalizedUrl: string } } }) => {
        if (args.where.crawlId_normalizedUrl.normalizedUrl === 'https://bad.test/') {
          throw new Error('write conflict');
        }
        return {};
      },
    );
    const db = { crawlPage: { update } } as any;
    const pages = fakePages(['https://good1.test/', 'https://bad.test/', 'https://good2.test/']);

    await expect(persistInboundLinkCounts(db, 'crawl1', pages, new Map())).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('bounds concurrent writes instead of running all of them at once', async () => {
    let active = 0;
    let maxActive = 0;
    const update = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {};
    });
    const db = { crawlPage: { update } } as any;
    const pages = fakePages(Array.from({ length: 25 }, (_, i) => `https://x.test/${i}`));

    await persistInboundLinkCounts(db, 'crawl1', pages, new Map());

    expect(update).toHaveBeenCalledTimes(25);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(10);
  });
});

describe('persistCrawlIssues', () => {
  const crawl: CrawlRow = { id: 'crawl1', organizationId: 'org1', websiteId: 'site1' };

  it('resolves pageId via crawlPage.findUnique for a URL-scoped issue', async () => {
    const findUnique = vi.fn(async () => ({ id: 'page-123' }));
    const upsert = vi.fn(
      async (_args: {
        create: { pageId: string | null };
        where: {
          crawlId_code_normalizedUrl: { crawlId: string; code: string; normalizedUrl: string };
        };
      }) => ({}),
    );
    const db = { crawlPage: { findUnique }, crawlIssue: { upsert } } as any;

    await persistCrawlIssues(db, crawl, [fakeIssue()]);

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        crawlId_normalizedUrl: { crawlId: 'crawl1', normalizedUrl: 'https://example.test/page' },
      },
      select: { id: true },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]![0];
    expect(call.create.pageId).toBe('page-123');
    expect(call.where).toEqual({
      crawlId_code_normalizedUrl: {
        crawlId: 'crawl1',
        code: 'missing-title',
        normalizedUrl: 'https://example.test/page',
      },
    });
  });

  it('skips findUnique and uses a null pageId for a site-wide issue', async () => {
    const findUnique = vi.fn(async () => ({ id: 'page-123' }));
    const upsert = vi.fn(
      async (_args: {
        create: { pageId: string | null };
        where: {
          crawlId_code_normalizedUrl: { crawlId: string; code: string; normalizedUrl: string };
        };
      }) => ({}),
    );
    const db = { crawlPage: { findUnique }, crawlIssue: { upsert } } as any;

    await persistCrawlIssues(db, crawl, [fakeIssue({ code: 'no-sitemap', normalizedUrl: null })]);

    expect(findUnique).not.toHaveBeenCalled();
    const call = upsert.mock.calls[0]![0];
    expect(call.create.pageId).toBeNull();
    expect(call.where.crawlId_code_normalizedUrl.normalizedUrl).toBe('');
  });

  it('swallows a failed upsert and still persists the remaining issues', async () => {
    const findUnique = vi.fn(async () => null);
    const upsert = vi.fn(async (args: { create: { code: string } }) => {
      if (args.create.code === 'boom') throw new Error('constraint violation');
      return {};
    });
    const db = { crawlPage: { findUnique }, crawlIssue: { upsert } } as any;
    const issues = [
      fakeIssue({ code: 'ok-1', normalizedUrl: null }),
      fakeIssue({ code: 'boom', normalizedUrl: null }),
      fakeIssue({ code: 'ok-2', normalizedUrl: null }),
    ];

    await expect(persistCrawlIssues(db, crawl, issues)).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it('bounds concurrent writes instead of running all of them at once', async () => {
    let active = 0;
    let maxActive = 0;
    const upsert = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {};
    });
    const db = {
      crawlPage: { findUnique: vi.fn(async () => null) },
      crawlIssue: { upsert },
    } as any;
    const issues = Array.from({ length: 25 }, (_, i) =>
      fakeIssue({ code: `issue-${i}`, normalizedUrl: null }),
    );

    await persistCrawlIssues(db, crawl, issues);

    expect(upsert).toHaveBeenCalledTimes(25);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(10);
  });
});
