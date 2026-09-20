import { describe, expect, it } from 'vitest';
import type { Transport } from '../seo/fetch.js';
import { researchFetch } from './fetch.js';

function fakeTransport(html: string, contentType = 'text/html'): Transport {
  return async () => ({
    status: 200,
    headers: { 'content-type': contentType },
    bodyBuffer: Buffer.from(html, 'utf8'),
    truncated: false,
  });
}

describe('researchFetch', () => {
  it('extracts a citation with title, excerpt, retrieval time and content hash', async () => {
    const html =
      '<html><head><title>My Page</title></head><body><main>Hello world, this is content.</main></body></html>';
    const result = await researchFetch('https://example.com/page', {
      transport: fakeTransport(html),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.citation.title).toBe('My Page');
      expect(result.citation.excerpt).toContain('Hello world');
      expect(result.citation.sourceUrl).toBe('https://example.com/page');
      expect(result.citation.contentHash).toMatch(/^[0-9a-f]{16}$/);
      expect(new Date(result.citation.retrievedAt).toString()).not.toBe('Invalid Date');
    }
  });

  it('blocks a private/internal-network URL via the shared SSRF guard — no second implementation', async () => {
    const result = await researchFetch('http://169.254.169.254/latest/meta-data/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/restricted/);
  });

  it('refuses a non-HTML response', async () => {
    const result = await researchFetch('https://example.com/data.bin', {
      transport: fakeTransport('binary', 'application/octet-stream'),
    });
    expect(result.ok).toBe(false);
  });

  it('reports a page with no readable text rather than returning an empty citation', async () => {
    const result = await researchFetch('https://example.com/empty', {
      transport: fakeTransport('<html><body><script>var x=1;</script></body></html>'),
    });
    expect(result.ok).toBe(false);
  });

  it('marks excerptTruncated when the page exceeds the excerpt cap', async () => {
    const longText = 'word '.repeat(3_000);
    const html = `<html><body><main>${longText}</main></body></html>`;
    const result = await researchFetch('https://example.com/long', {
      transport: fakeTransport(html),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.citation.excerptTruncated).toBe(true);
  });
});
