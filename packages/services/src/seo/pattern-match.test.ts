import { describe, expect, it } from 'vitest';
import { wildcardMatch } from './pattern-match.js';

describe('wildcardMatch', () => {
  it('matches an exact literal pattern (no wildcard)', () => {
    expect(wildcardMatch('/about', '/about')).toBe(true);
    expect(wildcardMatch('/about', '/about/us')).toBe(false);
    expect(wildcardMatch('/about', '/abou')).toBe(false);
  });

  it('a lone "*" matches anything, including empty', () => {
    expect(wildcardMatch('*', '')).toBe(true);
    expect(wildcardMatch('*', '/anything/at/all')).toBe(true);
  });

  it('matches a prefix + wildcard suffix', () => {
    expect(wildcardMatch('/blog/*', '/blog/post-1')).toBe(true);
    expect(wildcardMatch('/blog/*', '/blog/')).toBe(true);
    expect(wildcardMatch('/blog/*', '/blog')).toBe(false); // needs the trailing text
    expect(wildcardMatch('/blog/*', '/shop/post-1')).toBe(false);
  });

  it('matches multiple wildcards in sequence', () => {
    expect(wildcardMatch('/a*b*c', '/aXXbYYc')).toBe(true);
    expect(wildcardMatch('/a*b*c', '/abc')).toBe(true);
    expect(wildcardMatch('/a*b*c', '/a-c')).toBe(false); // missing the "b"
  });

  it('the empty pattern only matches the empty string', () => {
    expect(wildcardMatch('', '')).toBe(true);
    expect(wildcardMatch('', 'x')).toBe(false);
  });

  it('resolves an adversarial many-wildcard pattern in well under a second', () => {
    // The exact shape that hung the old regex-based matcher indefinitely
    // (CRAWLER-SECURITY-AUDIT.md CRITICAL-2): many "*" separated by a literal
    // that never appears, matched against a long non-matching string.
    const pattern = `/${'a*'.repeat(30)}ZZZ`;
    const text = '/' + 'a'.repeat(60);
    const start = Date.now();
    const result = wildcardMatch(pattern, text);
    const elapsed = Date.now() - start;
    expect(result).toBe(false); // no "ZZZ" in the text — correctly a non-match
    expect(elapsed).toBeLessThan(200);
  });

  it('resolves an adversarial pattern against a matching string just as fast', () => {
    const pattern = `${'a*'.repeat(30)}b`;
    const text = 'a'.repeat(60) + 'b';
    const start = Date.now();
    expect(wildcardMatch(pattern, text)).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
