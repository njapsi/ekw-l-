import { describe, expect, it } from 'vitest';
import {
  InvalidUrlError,
  isInScope,
  normalizeUrl,
  parseUrl,
  registrableDomain,
  sameRegistrableDomain,
  urlPathDepth,
} from './url.js';

describe('normalizeUrl', () => {
  it('lowercases scheme + host and drops the default port', () => {
    expect(normalizeUrl('HTTP://Example.COM:80/Path')).toBe('http://example.com/Path');
    expect(normalizeUrl('https://Example.com:443/')).toBe('https://example.com/');
  });

  it('strips the fragment and tracking params, sorts the rest', () => {
    expect(normalizeUrl('https://x.com/a?b=2&utm_source=nl&a=1#frag')).toBe(
      'https://x.com/a?a=1&b=2',
    );
  });

  it('resolves ./ and ../ and collapses slashes', () => {
    expect(normalizeUrl('https://x.com/a/./b/../c')).toBe('https://x.com/a/c');
  });

  it('decodes unreserved percent-encoding but keeps reserved encoded', () => {
    expect(normalizeUrl('https://x.com/%7Euser/%2Fslash')).toBe('https://x.com/~user/%2Fslash');
  });

  it('applies the trailing-slash policy only to non-root paths', () => {
    expect(normalizeUrl('https://x.com/a/', { trailingSlash: 'remove' })).toBe('https://x.com/a');
    expect(normalizeUrl('https://x.com/a', { trailingSlash: 'add' })).toBe('https://x.com/a/');
    expect(normalizeUrl('https://x.com/', { trailingSlash: 'remove' })).toBe('https://x.com/');
  });

  it('is idempotent', () => {
    const once = normalizeUrl('https://Example.com/a/../b?z=1&utm_medium=x');
    expect(normalizeUrl(once)).toBe(once);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => parseUrl('ftp://x.com')).toThrow(InvalidUrlError);
    expect(() => parseUrl('javascript:alert(1)')).toThrow(InvalidUrlError);
  });
});

describe('registrable domain + scope', () => {
  it('handles plain and multi-label public suffixes', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(sameRegistrableDomain('blog.example.com', 'shop.example.com')).toBe(true);
    expect(sameRegistrableDomain('example.com', 'example.org')).toBe(false);
  });

  it('isInScope honours domain, include and exclude globs', () => {
    const boundary = {
      registrableDomain: 'example.com',
      additionalHosts: ['cdn.example.net'],
      includePaths: ['/blog/*'],
      excludePaths: ['/blog/draft/*'],
    };
    expect(isInScope('https://www.example.com/blog/post-1', boundary)).toBe(true);
    expect(isInScope('https://www.example.com/about', boundary)).toBe(false); // not in include
    expect(isInScope('https://www.example.com/blog/draft/x', boundary)).toBe(false); // excluded
    expect(isInScope('https://evil.com/blog/x', boundary)).toBe(false); // off-domain
    expect(isInScope('https://cdn.example.net/blog/x', boundary)).toBe(true); // additional host
  });
});

describe('adversarial include/exclude globs (CRAWLER-SECURITY-AUDIT.md CRITICAL-2)', () => {
  it('a many-wildcard exclude glob resolves in well under a second, not a hang', () => {
    // includePaths/excludePaths come from the org's own crawl config, but a
    // pathological pattern still hung the old regex-based matcher and could
    // freeze the shared worker process for every concurrent crawl job.
    const boundary = {
      registrableDomain: 'example.com',
      additionalHosts: [],
      includePaths: [],
      excludePaths: [`/${'a*'.repeat(30)}ZZZ`],
    };
    const evilUrl = 'https://example.com/' + 'a'.repeat(60);
    const start = Date.now();
    const result = isInScope(evilUrl, boundary);
    expect(Date.now() - start).toBeLessThan(200);
    expect(result).toBe(true); // no "ZZZ" in the path — the exclude glob does not match
  });
});

describe('urlPathDepth', () => {
  it('counts non-empty path segments', () => {
    expect(urlPathDepth('https://x.com/')).toBe(0);
    expect(urlPathDepth('https://x.com/a/b/c')).toBe(3);
  });
});
