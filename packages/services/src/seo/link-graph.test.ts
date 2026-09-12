import { describe, expect, it } from 'vitest';
import { simhash } from './fingerprint.js';
import { analyzeGraph, type GraphPage } from './link-graph.js';

function page(url: string, over: Partial<GraphPage> = {}): GraphPage {
  return {
    normalizedUrl: url,
    httpStatus: 200,
    redirectChain: [],
    indexable: true,
    noindex: false,
    title: null,
    metaDescription: null,
    contentHash: null,
    simhash: null,
    canonicalUrl: null,
    wordCount: 300,
    outboundLinks: [],
    ...over,
  };
}

const link = (to: string) => ({ toNormalizedUrl: to, isInternal: true, isNofollow: false });

describe('analyzeGraph', () => {
  it('computes BFS crawl depth from the seed', () => {
    const home = page('https://x.com/', { outboundLinks: [link('https://x.com/a')] });
    const a = page('https://x.com/a', { outboundLinks: [link('https://x.com/b')] });
    const b = page('https://x.com/b');
    const g = analyzeGraph({
      pages: [home, a, b],
      seeds: ['https://x.com/'],
      sitemapUrls: [],
      maxDepth: 5,
    });
    expect(g.depthByUrl.get('https://x.com/')).toBe(0);
    expect(g.depthByUrl.get('https://x.com/a')).toBe(1);
    expect(g.depthByUrl.get('https://x.com/b')).toBe(2);
  });

  it('finds orphan pages (in sitemap, unlinked)', () => {
    const home = page('https://x.com/');
    const orphan = page('https://x.com/lonely');
    const g = analyzeGraph({
      pages: [home, orphan],
      seeds: ['https://x.com/'],
      sitemapUrls: ['https://x.com/lonely'],
      maxDepth: 5,
    });
    expect(g.orphanPages).toContain('https://x.com/lonely');
  });

  it('flags broken internal links', () => {
    const home = page('https://x.com/', { outboundLinks: [link('https://x.com/missing')] });
    const missing = page('https://x.com/missing', { httpStatus: 404, indexable: false });
    const g = analyzeGraph({
      pages: [home, missing],
      seeds: ['https://x.com/'],
      sitemapUrls: [],
      maxDepth: 5,
    });
    expect(g.brokenInternalLinks).toEqual([
      { from: 'https://x.com/', to: 'https://x.com/missing', status: 404 },
    ]);
  });

  it('detects redirect chains and loops', () => {
    const chain = page('https://x.com/c', {
      redirectChain: [
        { from: 'https://x.com/c', to: 'https://x.com/c2', status: 301 },
        { from: 'https://x.com/c2', to: 'https://x.com/c3', status: 301 },
      ],
    });
    const loop = page('https://x.com/l', {
      redirectChain: [
        { from: 'https://x.com/l', to: 'https://x.com/l2', status: 302 },
        { from: 'https://x.com/l2', to: 'https://x.com/l2', status: 302 },
      ],
    });
    const g = analyzeGraph({ pages: [chain, loop], seeds: [], sitemapUrls: [], maxDepth: 5 });
    expect(g.redirectChains.map((c) => c.url)).toContain('https://x.com/c');
    expect(g.redirectLoops).toEqual(['https://x.com/l']);
  });

  it('clusters duplicate titles and identical content', () => {
    const p1 = page('https://x.com/1', { title: 'Same Title', contentHash: 'abc', wordCount: 100 });
    const p2 = page('https://x.com/2', { title: 'Same Title', contentHash: 'abc', wordCount: 100 });
    const g = analyzeGraph({ pages: [p1, p2], seeds: [], sitemapUrls: [], maxDepth: 5 });
    expect(g.duplicateTitleGroups[0]?.urls).toHaveLength(2);
    expect(g.duplicateUrlVariants[0]?.urls).toHaveLength(2);
  });

  it('detects parameter explosion', () => {
    const pages = Array.from({ length: 12 }, (_, i) => page(`https://x.com/search?q=${i}`));
    const g = analyzeGraph({ pages, seeds: [], sitemapUrls: [], maxDepth: 5 });
    expect(g.parameterExplosionPaths[0]?.path).toBe('https://x.com/search');
    expect(g.parameterExplosionPaths[0]?.variants).toBe(12);
  });

  it('clusters near-duplicate content by simhash', () => {
    const boilerplate =
      'this is a long article about growing your website traffic through better content and structure. '.repeat(
        10,
      );
    const p1 = page('https://x.com/1', { simhash: simhash(`${boilerplate}the end.`) });
    const p2 = page('https://x.com/2', { simhash: simhash(`${boilerplate}the finish.`) });
    const distinct = page('https://x.com/3', {
      simhash: simhash(
        'a totally unrelated short article about something else entirely different.',
      ),
    });
    const g = analyzeGraph({ pages: [p1, p2, distinct], seeds: [], sitemapUrls: [], maxDepth: 5 });
    const cluster = g.duplicateContentClusters.find((c) => c.urls.includes('https://x.com/1'));
    expect(cluster?.urls.sort()).toEqual(['https://x.com/1', 'https://x.com/2']);
  });

  it('CRAWLER-SECURITY-AUDIT.md HIGH-1: clustering a large, mostly-distinct crawl stays fast', () => {
    // Before the fix, clusterBySimhash scanned every existing cluster for
    // every page (O(n²) when most pages are distinct, the common case for a
    // real site) — this would take an unreasonably long time at this size.
    const pages = Array.from({ length: 4000 }, (_, i) =>
      page(`https://x.com/p${i}`, { simhash: simhash(`totally distinct article number ${i} `) }),
    );
    const start = Date.now();
    const g = analyzeGraph({ pages, seeds: [], sitemapUrls: [], maxDepth: 5 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(g.duplicateContentClusters.length).toBeLessThanOrEqual(pages.length);
  });
});
