/**
 * Sitemap parsing + analysis (docs/SEO-ENGINE.md SITEMAPS section). Handles
 * `<urlset>` and one level of `<sitemapindex>` nesting. Uses `fast-xml-parser`
 * with **entity expansion disabled** and a hard byte cap, so a hostile sitemap
 * cannot mount a billion-laughs / decompression-bomb style attack through us.
 *
 * Sitemap protocol limits are enforced: ≤ 50,000 URLs and ≤ 50 MB uncompressed
 * per file (https://www.sitemaps.org/protocol.html).
 */
import { XMLParser } from 'fast-xml-parser';

export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export interface SitemapUrlEntry {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
}

export interface SitemapIssue {
  code:
    | 'INVALID_XML'
    | 'EMPTY'
    | 'TOO_MANY_URLS'
    | 'TOO_LARGE'
    | 'MISSING_LOC'
    | 'BAD_LOC'
    | 'UNKNOWN_ROOT';
  detail: string;
}

export interface ParsedSitemap {
  kind: 'urlset' | 'sitemapindex' | 'unknown';
  /** For `urlset`: page URLs. For `sitemapindex`: child sitemap URLs. */
  entries: SitemapUrlEntry[];
  issues: SitemapIssue[];
  truncated: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  processEntities: false, // no entity expansion — hostile-input safety
  htmlEntities: false,
  parseTagValue: true,
  trimValues: true,
  // Never coerce loc strings to numbers/booleans.
  numberParseOptions: { hex: false, leadingZeros: false, eNotation: false },
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function coerceLoc(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number') return String(raw);
  return null;
}

export function parseSitemap(
  xml: string,
  opts: { maxUrls?: number; maxBytes?: number } = {},
): ParsedSitemap {
  const maxUrls = opts.maxUrls ?? SITEMAP_MAX_URLS;
  const maxBytes = opts.maxBytes ?? SITEMAP_MAX_BYTES;
  const issues: SitemapIssue[] = [];

  const byteLen = Buffer.byteLength(xml, 'utf8');
  if (byteLen > maxBytes) {
    issues.push({
      code: 'TOO_LARGE',
      detail: `Sitemap is ${(byteLen / 1024 / 1024).toFixed(1)} MB (limit ${maxBytes / 1024 / 1024} MB).`,
    });
    return { kind: 'unknown', entries: [], issues, truncated: true };
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    issues.push({ code: 'INVALID_XML', detail: e instanceof Error ? e.message : 'parse error' });
    return { kind: 'unknown', entries: [], issues, truncated: false };
  }

  const urlset = doc.urlset as { url?: unknown } | undefined;
  const sitemapindex = doc.sitemapindex as { sitemap?: unknown } | undefined;

  if (urlset) {
    const raw = asArray(urlset.url as Record<string, unknown> | Record<string, unknown>[]);
    const entries: SitemapUrlEntry[] = [];
    let truncated = false;
    for (const node of raw) {
      if (entries.length >= maxUrls) {
        truncated = true;
        break;
      }
      const loc = coerceLoc(node.loc);
      if (!loc) {
        issues.push({ code: 'MISSING_LOC', detail: 'a <url> has no <loc>' });
        continue;
      }
      entries.push({
        loc,
        lastmod: coerceLoc(node.lastmod),
        changefreq: coerceLoc(node.changefreq),
        priority: node.priority != null ? Number(node.priority) : null,
      });
    }
    if (raw.length > maxUrls) {
      truncated = true;
      issues.push({
        code: 'TOO_MANY_URLS',
        detail: `Sitemap lists ${raw.length} URLs (protocol limit ${maxUrls}).`,
      });
    }
    if (entries.length === 0) issues.push({ code: 'EMPTY', detail: 'urlset has no usable <url>.' });
    return { kind: 'urlset', entries, issues, truncated };
  }

  if (sitemapindex) {
    const raw = asArray(
      sitemapindex.sitemap as Record<string, unknown> | Record<string, unknown>[],
    );
    const entries: SitemapUrlEntry[] = [];
    for (const node of raw) {
      const loc = coerceLoc(node.loc);
      if (!loc) {
        issues.push({ code: 'MISSING_LOC', detail: 'a <sitemap> has no <loc>' });
        continue;
      }
      entries.push({ loc, lastmod: coerceLoc(node.lastmod), changefreq: null, priority: null });
    }
    if (entries.length === 0)
      issues.push({ code: 'EMPTY', detail: 'sitemapindex has no usable <sitemap>.' });
    return { kind: 'sitemapindex', entries, issues, truncated: false };
  }

  issues.push({
    code: 'UNKNOWN_ROOT',
    detail: 'root element is neither <urlset> nor <sitemapindex>.',
  });
  return { kind: 'unknown', entries: [], issues, truncated: false };
}
