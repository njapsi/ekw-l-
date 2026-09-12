import { describe, expect, it } from 'vitest';
import type { FetchOutcome } from './fetch.js';
import { extractPage } from './html.js';
import { evaluatePage } from './page-eval.js';

function okOutcome(over: Partial<Extract<FetchOutcome, { ok: true }>> = {}): FetchOutcome {
  return {
    ok: true,
    status: 200,
    finalUrl: 'https://example.com/p',
    redirects: [],
    headers: { 'content-type': 'text/html' },
    contentType: 'text/html',
    body: '',
    bodyBytes: 100,
    truncated: false,
    isHtml: true,
    ...over,
  };
}

const html = (extra: string) =>
  `<html lang="en"><head><title>T</title>${extra}</head><body><h1>H</h1><p>words words words words words</p></body></html>`;

describe('evaluatePage', () => {
  it('marks a normal 200 page indexable', () => {
    const ex = extractPage(
      html('<link rel="canonical" href="https://example.com/p">'),
      'https://example.com/p',
    );
    const rec = evaluatePage({
      requestedUrl: 'https://example.com/p',
      normalizedUrl: 'https://example.com/p',
      depth: 1,
      discoveredVia: 'link',
      fetch: okOutcome(),
      extracted: ex,
      rendered: null,
      responseTimeMs: 120,
      robotsAllowed: true,
    });
    expect(rec.indexable).toBe(true);
    expect(rec.canonicalIsSelf).toBe(true);
    expect(rec.crawlable).toBe(true);
  });

  it('honours meta robots noindex', () => {
    const ex = extractPage(
      html('<meta name="robots" content="noindex,follow">'),
      'https://example.com/p',
    );
    const rec = evaluatePage({
      requestedUrl: 'https://example.com/p',
      normalizedUrl: 'https://example.com/p',
      depth: 1,
      discoveredVia: 'link',
      fetch: okOutcome(),
      extracted: ex,
      rendered: null,
      responseTimeMs: 10,
      robotsAllowed: true,
    });
    expect(rec.noindex).toBe(true);
    expect(rec.indexable).toBe(false);
    expect(rec.indexabilityReason).toMatch(/noindex/i);
  });

  it('honours the X-Robots-Tag header', () => {
    const ex = extractPage(html(''), 'https://example.com/p');
    const rec = evaluatePage({
      requestedUrl: 'https://example.com/p',
      normalizedUrl: 'https://example.com/p',
      depth: 1,
      discoveredVia: 'link',
      fetch: okOutcome({ headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' } }),
      extracted: ex,
      rendered: null,
      responseTimeMs: 10,
      robotsAllowed: true,
    });
    expect(rec.noindex).toBe(true);
    expect(rec.indexable).toBe(false);
  });

  it('a robots-blocked path is not crawlable or indexable', () => {
    const ex = extractPage(html(''), 'https://example.com/p');
    const rec = evaluatePage({
      requestedUrl: 'https://example.com/p',
      normalizedUrl: 'https://example.com/p',
      depth: 1,
      discoveredVia: 'link',
      fetch: okOutcome(),
      extracted: ex,
      rendered: null,
      responseTimeMs: 10,
      robotsAllowed: false,
    });
    expect(rec.crawlable).toBe(false);
    expect(rec.robotsBlocked).toBe(true);
    expect(rec.indexable).toBe(false);
  });

  it('records a fetch failure without inventing content', () => {
    const rec = evaluatePage({
      requestedUrl: 'https://example.com/x',
      normalizedUrl: 'https://example.com/x',
      depth: 2,
      discoveredVia: 'link',
      fetch: { ok: false, reason: 'timeout', detail: 'timed out', redirects: [] },
      extracted: null,
      rendered: null,
      responseTimeMs: null,
      robotsAllowed: true,
    });
    expect(rec.httpStatus).toBeNull();
    expect(rec.indexable).toBe(false);
    expect(rec.fetchError).toMatch(/timeout/);
    expect(rec.title).toBeNull();
  });

  it('detects mixed content on an HTTPS page', () => {
    const ex = extractPage(
      `<html><head><title>T</title></head><body><a href="http://insecure.example/x">link</a></body></html>`,
      'https://example.com/p',
    );
    const rec = evaluatePage({
      requestedUrl: 'https://example.com/p',
      normalizedUrl: 'https://example.com/p',
      depth: 1,
      discoveredVia: 'link',
      fetch: okOutcome(),
      extracted: ex,
      rendered: null,
      responseTimeMs: 10,
      robotsAllowed: true,
    });
    expect(rec.mixedContent).toBe(true);
  });
});
