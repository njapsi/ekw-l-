import { describe, expect, it } from 'vitest';
import { extractPage } from './html.js';

const BASE = 'https://example.com/blog/post';

const FULL = `<!doctype html>
<html lang="en-GB">
<head>
  <title>  My Post Title  </title>
  <meta name="description" content="A short summary of the post.">
  <meta name="robots" content="index, follow">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="https://example.com/blog/post">
  <link rel="alternate" hreflang="fr" href="https://example.com/fr/blog/post">
  <meta property="og:title" content="My Post">
  <meta property="og:image" content="https://example.com/img.png">
  <meta name="twitter:card" content="summary">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"My Post"}</script>
  <script type="application/ld+json">{ not valid json </script>
</head>
<body>
  <h1>Heading One</h1>
  <h2>Sub</h2>
  <h4>Skipped h3</h4>
  <p>Some words here that make up the body content for the word count test to pass thresholds.</p>
  <a href="/blog/other">internal</a>
  <a href="https://other.com/x" rel="nofollow noopener">external nofollow</a>
  <a href="https://example.com/deep/link">same-site absolute</a>
  <img src="/a.png" alt="described">
  <img src="/b.png">
  <img src="/c.png" width="10" height="10">
</body>
</html>`;

describe('extractPage', () => {
  const ex = extractPage(FULL, BASE);

  it('pulls title / description / canonical / lang / viewport', () => {
    expect(ex.title).toBe('My Post Title');
    expect(ex.metaDescription).toBe('A short summary of the post.');
    expect(ex.canonicalUrl).toBe('https://example.com/blog/post');
    expect(ex.lang).toBe('en-GB');
    expect(ex.viewportMeta).toBe(true);
    expect(ex.robotsDirectives).toContain('index');
  });

  it('classifies links as internal/external and detects nofollow', () => {
    expect(ex.internalLinks.map((l) => l.normalizedUrl)).toEqual(
      expect.arrayContaining(['https://example.com/blog/other', 'https://example.com/deep/link']),
    );
    const ext = ex.externalLinks.find((l) => l.href.includes('other.com'));
    expect(ext?.isNofollow).toBe(true);
  });

  it('counts images and missing alt / dimensions', () => {
    expect(ex.imagesTotal).toBe(3);
    expect(ex.imagesMissingAlt).toBe(2); // b.png and c.png have no alt attribute
    expect(ex.imagesMissingDimensions).toBe(2); // a.png and b.png have no width/height
  });

  it('parses JSON-LD types and records invalid blocks', () => {
    expect(ex.jsonLdTypes).toContain('Article');
    expect(ex.jsonLdErrors).toHaveLength(1);
  });

  it('captures OG / Twitter / hreflang', () => {
    expect(ex.openGraph['og:title']).toBe('My Post');
    expect(ex.twitter['twitter:card']).toBe('summary');
    expect(ex.hreflang[0]).toEqual({ hreflang: 'fr', href: 'https://example.com/fr/blog/post' });
  });

  it('flags a broken heading order', () => {
    expect(ex.headingOrderOk).toBe(false);
    expect(ex.h1Count).toBe(1);
  });

  it('flags CSR when the static HTML is near-empty with framework markers', () => {
    const csr = extractPage(
      `<html><head><title>App</title></head><body><div id="__next"></div>
      <script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></body></html>`,
      BASE,
    );
    expect(csr.csrLikely).toBe(true);
  });
});
