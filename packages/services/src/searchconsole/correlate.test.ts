import { describe, expect, it } from 'vitest';
import { correlate, type CorrIssue, type CorrPage } from './correlate.js';
import type { PerfRow } from './schemas.js';

const row = (url: string, impressions: number, clicks: number, position = 8): PerfRow => ({
  keys: [url],
  impressions,
  clicks,
  ctr: impressions ? clicks / impressions : 0,
  position,
});
const page = (over: Partial<CorrPage> & { normalizedUrl: string }): CorrPage => ({
  title: 'A page',
  titleLength: 20,
  metaDescription: 'desc',
  inboundInternalCount: 10,
  indexable: true,
  httpStatus: 200,
  ...over,
});

describe('correlate — crawler × Search Console', () => {
  it('flags a HIGH/CRITICAL crawl issue on a page that receives impressions', () => {
    const res = correlate({
      byPage: [row('https://x.com/a', 200, 4), row('https://x.com/b', 3, 0)],
      pages: [
        page({ normalizedUrl: 'https://x.com/a' }),
        page({ normalizedUrl: 'https://x.com/b' }),
      ],
      issues: [
        {
          code: 'CANONICAL_CONFLICT',
          severity: 'HIGH',
          normalizedUrl: 'https://x.com/a',
          title: 'Canonical conflict',
        },
        { code: 'IMG_ALT', severity: 'LOW', normalizedUrl: 'https://x.com/a', title: 'Alt text' },
        {
          code: 'SERVER_ERROR',
          severity: 'CRITICAL',
          normalizedUrl: 'https://x.com/b',
          title: '500',
        },
      ],
      sitemapUrls: [],
    });
    const hits = res.correlations.filter((c) => c.kind === 'crawl_issue_on_impression_page');
    expect(hits).toHaveLength(1); // /a HIGH only; /b below the impressions floor; /a LOW excluded
    expect(hits[0]!.url).toBe('https://x.com/a');
    expect(hits[0]!.crawlerEvidence).toContain('CANONICAL_CONFLICT');
    expect(hits[0]!.searchConsoleEvidence).toContain('200 impression');
  });

  it('flags impressions but low CTR, noting the crawl title/meta state', () => {
    const res = correlate({
      byPage: [
        row('https://x.com/hi', 400, 40), // 10% ctr — healthy
        row('https://x.com/lo', 400, 2), // 0.5% ctr — well below
      ],
      pages: [
        page({ normalizedUrl: 'https://x.com/hi' }),
        page({ normalizedUrl: 'https://x.com/lo', title: '', metaDescription: '' }),
      ],
      issues: [],
      sitemapUrls: [],
    });
    const hits = res.correlations.filter((c) => c.kind === 'impressions_but_low_ctr');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe('https://x.com/lo');
    expect(hits[0]!.crawlerEvidence).toMatch(/no <title>/i);
  });

  it('flags sitemap pages with weak internal linking that earn impressions', () => {
    const res = correlate({
      byPage: [row('https://x.com/deep', 30, 1), row('https://x.com/well-linked', 30, 1)],
      pages: [
        page({ normalizedUrl: 'https://x.com/deep', inboundInternalCount: 1 }),
        page({ normalizedUrl: 'https://x.com/well-linked', inboundInternalCount: 9 }),
      ],
      issues: [],
      sitemapUrls: ['https://x.com/deep', 'https://x.com/well-linked'],
    });
    const hits = res.correlations.filter((c) => c.kind === 'sitemap_page_weak_internal_links');
    expect(hits.map((h) => h.url)).toEqual(['https://x.com/deep']);
    expect(hits[0]!.crawlerEvidence).toContain('1 internal link');
  });

  it('empty inputs → no correlations', () => {
    const res = correlate({ byPage: [], pages: [], issues: [] as CorrIssue[], sitemapUrls: [] });
    expect(res.correlations).toEqual([]);
    expect(res.pagesWithImpressions).toBe(0);
  });

  it('normalises trailing slashes when matching URLs', () => {
    const res = correlate({
      byPage: [row('https://x.com/a/', 50, 0)],
      pages: [page({ normalizedUrl: 'https://x.com/a' })],
      issues: [
        { code: 'NOINDEX', severity: 'HIGH', normalizedUrl: 'https://x.com/a', title: 'noindex' },
      ],
      sitemapUrls: [],
    });
    expect(res.correlations.some((c) => c.kind === 'crawl_issue_on_impression_page')).toBe(true);
  });
});
