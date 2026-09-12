import { describe, expect, it } from 'vitest';
import {
  importantPathsBlocked,
  isFullyDisallowed,
  isPathAllowed,
  matchRobots,
  parseRobots,
} from './robots.js';

const UA = 'GrowthAgentBot';

describe('parseRobots', () => {
  it('groups rules by user-agent and collects Sitemap directives', () => {
    const p = parseRobots(`
User-agent: *
Disallow: /private/
Allow: /private/public.html
Crawl-delay: 2

User-agent: BadBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`);
    expect(p.groups).toHaveLength(2);
    expect(p.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(p.groups[0]?.crawlDelaySec).toBe(2);
  });

  it('flags syntax problems without throwing', () => {
    const p = parseRobots('This is not valid\nDisallow /no-colon\nFrobnicate: yes');
    expect(p.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe('matchRobots — longest match wins, Allow breaks ties', () => {
  const p = parseRobots(`
User-agent: *
Disallow: /a/
Allow: /a/b/
Disallow: /x$
`);

  it('applies the more specific rule', () => {
    expect(isPathAllowed(p, '/a/page', UA)).toBe(false);
    expect(isPathAllowed(p, '/a/b/page', UA)).toBe(true);
  });

  it('honours the $ end-anchor', () => {
    expect(isPathAllowed(p, '/x', UA)).toBe(false);
    expect(isPathAllowed(p, '/x/y', UA)).toBe(true);
  });

  it('an equal-length Allow beats Disallow', () => {
    const q = parseRobots('User-agent: *\nDisallow: /p\nAllow: /p');
    expect(matchRobots(q, '/p', UA).allowed).toBe(true);
  });

  it('empty Disallow means allow-all', () => {
    const q = parseRobots('User-agent: *\nDisallow:');
    expect(isPathAllowed(q, '/anything', UA)).toBe(true);
  });
});

describe('specific vs wildcard user-agent groups', () => {
  const p = parseRobots(`
User-agent: *
Disallow: /

User-agent: GrowthAgentBot
Disallow: /admin/
`);
  it('picks the token that matches our UA', () => {
    expect(isPathAllowed(p, '/public', UA)).toBe(true);
    expect(isPathAllowed(p, '/admin/x', UA)).toBe(false);
    expect(isPathAllowed(p, '/public', 'RandomCrawler')).toBe(false);
  });
});

describe('adversarial robots.txt (CRAWLER-SECURITY-AUDIT.md CRITICAL-2)', () => {
  it('a many-wildcard Disallow pattern resolves in well under a second, not a hang', () => {
    // The exact shape that hung the old regex-based (`* -> .*`) matcher
    // indefinitely: a robots.txt is entirely attacker-controlled (it's the
    // crawled site's own file), and matchRobots runs once per candidate URL.
    const p = parseRobots(`User-agent: *\nDisallow: /${'a*'.repeat(30)}ZZZ\n`);
    const evilPath = '/' + 'a'.repeat(60);
    const start = Date.now();
    const result = isPathAllowed(p, evilPath, UA);
    expect(Date.now() - start).toBeLessThan(200);
    // No "ZZZ" in the path, so the Disallow rule does not match — allowed.
    expect(result).toBe(true);
  });
});

describe('site-wide analysis helpers', () => {
  it('detects a full disallow', () => {
    expect(isFullyDisallowed(parseRobots('User-agent: *\nDisallow: /'), UA)).toBe(true);
    expect(isFullyDisallowed(parseRobots('User-agent: *\nDisallow: /tmp/'), UA)).toBe(false);
  });

  it('reports important paths that are blocked', () => {
    const p = parseRobots('User-agent: *\nDisallow: /products/');
    const blocked = importantPathsBlocked(p, ['/products/widget', '/about'], UA);
    expect(blocked.map((b) => b.path)).toEqual(['/products/widget']);
  });
});
