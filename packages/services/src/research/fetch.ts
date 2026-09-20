/**
 * The controlled web-research fetch tool (Phase 5, Parts 41-44). Reuses the
 * crawler's own SSRF-safe HTTP client (`seo/fetch.ts`'s `fetchPage`) rather
 * than a second implementation of URL validation, DNS-rebinding defense,
 * redirect handling, or decompression caps (Part 42 — "Do NOT create a
 * second SSRF implementation"). `fetchPage` itself has no ownership
 * requirement — the crawler layers that on top of it separately for
 * crawling a tenant's own site — so calling it directly here for an
 * arbitrary public URL does not bypass anything the crawler enforces for
 * its own purpose.
 *
 * The result is a citation, not a raw page dump (Part 44): source URL,
 * title, retrieval time, a bounded excerpt, and a content hash so a caller
 * can tell whether two fetches of the same URL returned the same content.
 */
import { createHash } from 'node:crypto';
import { fetchPage, type FetchPageOptions } from '../seo/fetch.js';
import { extractReadableText } from './extract.js';

export interface ResearchCitation {
  sourceUrl: string;
  title: string | null;
  retrievedAt: string;
  excerpt: string;
  excerptTruncated: boolean;
  contentHash: string;
}

export type ResearchFetchResult =
  { ok: true; citation: ResearchCitation } | { ok: false; reason: string };

const MAX_EXCERPT_CHARS = 6_000;

export async function researchFetch(
  url: string,
  opts: FetchPageOptions = {},
): Promise<ResearchFetchResult> {
  const outcome = await fetchPage(url, {
    // Research reads a page once for its own text, not for a crawl's link
    // graph; a smaller cap than the crawler's default keeps a hostile
    // response from consuming a disproportionate share of the run's budget.
    maxBytes: 3 * 1024 * 1024,
    ...opts,
  });

  if (!outcome.ok) {
    const reasonText: Record<typeof outcome.reason, string> = {
      blocked: 'That URL could not be fetched (it points to a restricted network location).',
      too_large: 'The page was too large to fetch.',
      timeout: 'The page took too long to respond.',
      network: 'The page could not be reached.',
      too_many_redirects: 'The page redirected too many times.',
      redirect_loop: 'The page redirected back to itself.',
    };
    return { ok: false, reason: reasonText[outcome.reason] };
  }

  if (!outcome.isHtml) {
    return { ok: false, reason: 'That URL did not return a readable (HTML/text) page.' };
  }

  const { title, text, truncated } = extractReadableText(outcome.body, MAX_EXCERPT_CHARS);
  if (!text) {
    return { ok: false, reason: 'The page had no readable text content.' };
  }

  return {
    ok: true,
    citation: {
      sourceUrl: outcome.finalUrl,
      title,
      retrievedAt: new Date().toISOString(),
      excerpt: text,
      excerptTruncated: truncated,
      contentHash: createHash('sha256').update(text).digest('hex').slice(0, 16),
    },
  };
}
