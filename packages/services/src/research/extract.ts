/**
 * Plain readable-text extraction for the research tool (Phase 5, Part 41).
 * Deliberately much smaller than `seo/html.ts`'s `extractPage` — that
 * function extracts SEO-specific structure (links, headings, JSON-LD,
 * hreflang) for the crawler's own auditor, which research has no use for.
 * This just gets a bounded amount of prose a model can read as a citation
 * excerpt.
 */
import * as cheerio from 'cheerio';

export interface ExtractedText {
  title: string | null;
  text: string;
  truncated: boolean;
}

const REMOVE_SELECTORS = 'script, style, noscript, nav, header, footer, svg, iframe, template';

export function extractReadableText(html: string, maxChars = 8_000): ExtractedText {
  const $ = cheerio.load(html);
  $(REMOVE_SELECTORS).remove();
  const title = $('title').first().text().trim() || null;
  const raw = ($('main').text() || $('article').text() || $('body').text() || '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = raw.length > maxChars;
  return { title, text: truncated ? raw.slice(0, maxChars) : raw, truncated };
}
