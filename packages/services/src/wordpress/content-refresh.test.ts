import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { findRefreshCandidates } from './content-refresh.js';

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function makeDb(opts: {
  content?: Array<Record<string, unknown>>;
  site?: Record<string, unknown> | null;
  website?: Record<string, unknown> | null;
  crawl?: Record<string, unknown> | null;
  pages?: Array<Record<string, unknown>>;
  issues?: Array<Record<string, unknown>>;
}): Db {
  const content = opts.content ?? [];
  return {
    wordPressContent: { findMany: vi.fn(async () => content) },
    wordPressSite: { findFirst: vi.fn(async () => opts.site ?? null) },
    website: { findFirst: vi.fn(async () => opts.website ?? null) },
    crawl: { findFirst: vi.fn(async () => opts.crawl ?? null) },
    crawlPage: { findMany: vi.fn(async () => opts.pages ?? []) },
    crawlIssue: { findMany: vi.fn(async () => opts.issues ?? []) },
  } as unknown as Db;
}

describe('findRefreshCandidates', () => {
  it('returns nothing when there is no synced content', async () => {
    const db = makeDb({ content: [] });
    expect(await findRefreshCandidates('org_1', {}, db)).toEqual([]);
  });

  it('scores an old, issue-heavy, thin page higher than a fresh healthy one', async () => {
    const db = makeDb({
      content: [
        {
          id: 'c1',
          wpId: 1,
          type: 'POST',
          title: 'Old thin post',
          link: 'https://example.com/old-thin-post',
          status: 'publish',
          modifiedAt: daysAgo(500),
        },
        {
          id: 'c2',
          wpId: 2,
          type: 'POST',
          title: 'Fresh healthy post',
          link: 'https://example.com/fresh-healthy-post',
          status: 'publish',
          modifiedAt: daysAgo(2),
        },
      ],
      site: { id: 'site_1', siteUrl: 'https://example.com' },
      website: { id: 'web_1', hostname: 'example.com' },
      crawl: { id: 'crawl_1' },
      pages: [
        { normalizedUrl: 'https://example.com/old-thin-post', wordCount: 120 },
        { normalizedUrl: 'https://example.com/fresh-healthy-post', wordCount: 1800 },
      ],
      issues: [
        { normalizedUrl: 'https://example.com/old-thin-post', severity: 'CRITICAL' },
        { normalizedUrl: 'https://example.com/old-thin-post', severity: 'HIGH' },
      ],
    });
    const candidates = await findRefreshCandidates('org_1', { siteId: 'site_1' }, db);
    expect(candidates[0]!.title).toBe('Old thin post');
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
  });

  it('never fabricates an issue count or word count for unmatched content — reports honest nulls/zeros', async () => {
    const db = makeDb({
      content: [
        {
          id: 'c1',
          wpId: 1,
          type: 'POST',
          title: 'Unmatched post',
          link: 'https://example.com/unmatched',
          status: 'publish',
          modifiedAt: daysAgo(10),
        },
      ],
      site: { id: 'site_1', siteUrl: 'https://example.com' },
      website: null, // no crawled website at all
    });
    const candidates = await findRefreshCandidates('org_1', { siteId: 'site_1' }, db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.wordCount).toBeNull();
    expect(candidates[0]!.issueCount).toBe(0);
    expect(candidates[0]!.confidence).not.toBe('HIGH');
  });

  it('excludes non-published content', async () => {
    const db = makeDb({
      content: [
        { id: 'c1', wpId: 1, type: 'POST', title: 'Draft', link: null, status: 'draft', modifiedAt: daysAgo(1) },
      ],
      site: { id: 'site_1', siteUrl: 'https://example.com' },
    });
    const candidates = await findRefreshCandidates('org_1', { siteId: 'site_1' }, db);
    expect(candidates).toHaveLength(0);
  });

  it('caps results at the requested limit', async () => {
    const content = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      wpId: i,
      type: 'POST',
      title: `Post ${i}`,
      link: `https://example.com/post-${i}`,
      status: 'publish',
      modifiedAt: daysAgo(i),
    }));
    const db = makeDb({ content, site: { id: 'site_1', siteUrl: 'https://example.com' } });
    const candidates = await findRefreshCandidates('org_1', { siteId: 'site_1', limit: 5 }, db);
    expect(candidates).toHaveLength(5);
  });
});
