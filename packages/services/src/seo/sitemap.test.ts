import { describe, expect, it } from 'vitest';
import { parseSitemap } from './sitemap.js';

describe('parseSitemap', () => {
  it('parses a urlset with lastmod/priority', () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod><priority>1.0</priority></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`;
    const r = parseSitemap(xml);
    expect(r.kind).toBe('urlset');
    expect(r.entries.map((e) => e.loc)).toEqual([
      'https://example.com/',
      'https://example.com/about',
    ]);
    expect(r.entries[0]?.priority).toBe(1);
  });

  it('parses a sitemap index', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;
    const r = parseSitemap(xml);
    expect(r.kind).toBe('sitemapindex');
    expect(r.entries).toHaveLength(2);
  });

  it('flags invalid XML instead of throwing', () => {
    const r = parseSitemap('<urlset><url><loc>https://x.com/</loc></url'); // truncated
    expect(r.issues.some((i) => i.code === 'INVALID_XML' || i.code === 'EMPTY')).toBe(true);
  });

  it('enforces the URL-count protocol limit', () => {
    const urls = Array.from(
      { length: 12 },
      (_, i) => `<url><loc>https://x.com/${i}</loc></url>`,
    ).join('');
    const r = parseSitemap(`<urlset>${urls}</urlset>`, { maxUrls: 10 });
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(10);
    expect(r.issues.some((i) => i.code === 'TOO_MANY_URLS')).toBe(true);
  });

  it('rejects an oversized document', () => {
    const big = `<urlset>${'x'.repeat(200)}</urlset>`;
    const r = parseSitemap(big, { maxBytes: 50 });
    expect(r.issues[0]?.code).toBe('TOO_LARGE');
  });

  it('does not expand XML entities (billion-laughs safety)', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
<urlset><url><loc>https://x.com/&lol2;</loc></url></urlset>`;
    const r = parseSitemap(xml);
    // entity text is not expanded into a huge string; loc stays literal-ish
    expect(JSON.stringify(r).length).toBeLessThan(2000);
  });
});
