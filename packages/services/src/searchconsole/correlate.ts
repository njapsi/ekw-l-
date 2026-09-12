/**
 * Deterministic joins between an already-run crawl and a Search Console
 * PERFORMANCE snapshot. Nothing here is a prediction and nothing calls a model:
 * each correlation is a fact from the crawler plus a fact from Search Console,
 * with a fixed interpretation sentence. The AI SEO Agent renders these under a
 * clear "AI interpretation" label; the underlying numbers stay attributed.
 */
import type { PerfRow } from './schemas.js';

export interface CorrPage {
  normalizedUrl: string;
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  inboundInternalCount: number;
  indexable: boolean;
  httpStatus: number | null;
}

export interface CorrIssue {
  code: string;
  severity: string;
  normalizedUrl: string | null;
  title: string;
}

export type CorrelationKind =
  'crawl_issue_on_impression_page' | 'impressions_but_low_ctr' | 'sitemap_page_weak_internal_links';

export interface Correlation {
  kind: CorrelationKind;
  url: string;
  /** Search Console figures for this URL. */
  gsc: { clicks: number; impressions: number; ctr: number; position: number };
  crawlerEvidence: string;
  searchConsoleEvidence: string;
  interpretation: string;
}

function normalize(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    let s = url.toString();
    if (s.endsWith('/') && url.pathname !== '/') s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return u.toLowerCase().replace(/\/$/, '');
  }
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export interface CorrelateInput {
  byPage: PerfRow[];
  pages: CorrPage[];
  issues: CorrIssue[];
  /** Normalized URLs that appeared in the crawl's sitemap. */
  sitemapUrls: string[];
}

export interface CorrelateResult {
  correlations: Correlation[];
  counts: Record<CorrelationKind, number>;
  pagesWithImpressions: number;
}

const MIN_IMPRESSIONS_ISSUE = 10;
const MIN_IMPRESSIONS_CTR = 25;
const MIN_IMPRESSIONS_SITEMAP = 5;
const WEAK_INLINKS = 3;
const HIGH_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

export function correlate(input: CorrelateInput): CorrelateResult {
  const pageByUrl = new Map(input.pages.map((p) => [normalize(p.normalizedUrl), p]));
  const issuesByUrl = new Map<string, CorrIssue[]>();
  for (const i of input.issues) {
    if (!i.normalizedUrl) continue;
    const k = normalize(i.normalizedUrl);
    const arr = issuesByUrl.get(k);
    if (arr) arr.push(i);
    else issuesByUrl.set(k, [i]);
  }
  const sitemapSet = new Set(input.sitemapUrls.map(normalize));

  const gscRows = input.byPage
    .map((r) => ({ url: normalize(r.keys[0] ?? ''), row: r }))
    .filter((x) => x.url);
  const pagesWithImpressions = gscRows.filter((x) => x.row.impressions > 0).length;
  const medianCtr = median(gscRows.filter((x) => x.row.impressions >= 5).map((x) => x.row.ctr));
  const ctrFloor = Math.max(0.5 * medianCtr, 0.01);

  const out: Correlation[] = [];

  // 1. Crawl issue affecting a page that receives impressions.
  for (const { url, row } of gscRows) {
    if (row.impressions < MIN_IMPRESSIONS_ISSUE) continue;
    const issues = (issuesByUrl.get(url) ?? []).filter((i) => HIGH_SEVERITIES.has(i.severity));
    for (const issue of issues) {
      out.push({
        kind: 'crawl_issue_on_impression_page',
        url,
        gsc: mini(row),
        crawlerEvidence: `The crawl flagged ${issue.severity} issue ${issue.code} on this page ("${issue.title}").`,
        searchConsoleEvidence: `Search Console reports ${row.impressions} impression(s) and ${row.clicks} click(s) for this URL in the window.`,
        interpretation:
          'A page Google is already showing to users has an unresolved technical issue; fixing it removes a drag on a URL that is already earning visibility.',
      });
    }
  }

  // 2. Page receives impressions but has a poor click-through rate.
  for (const { url, row } of gscRows) {
    if (row.impressions < MIN_IMPRESSIONS_CTR || row.ctr >= ctrFloor) continue;
    const page = pageByUrl.get(url);
    const titleNote = !page
      ? 'The crawl did not reach this URL.'
      : page.title == null || page.title.trim() === ''
        ? 'The crawl found no <title> on this page.'
        : (page.titleLength ?? 0) > 60
          ? `The crawl found a long title (${page.titleLength} chars) on this page.`
          : page.metaDescription == null || page.metaDescription.trim() === ''
            ? 'The crawl found no meta description on this page.'
            : 'The crawl found a title and meta description present.';
    out.push({
      kind: 'impressions_but_low_ctr',
      url,
      gsc: mini(row),
      crawlerEvidence: titleNote,
      searchConsoleEvidence: `Search Console reports ${row.impressions} impression(s) at avg position ${row.position.toFixed(1)} but a click-through rate of ${pct(row.ctr)} (window median ${pct(medianCtr)}).`,
      interpretation:
        'The page is being shown but rarely clicked. The snippet (title / meta description) is the usual lever; it does not change ranking, only the appeal of the result.',
    });
  }

  // 3. Important pages exist in the sitemap but have weak internal linking.
  for (const { url, row } of gscRows) {
    if (row.impressions < MIN_IMPRESSIONS_SITEMAP || !sitemapSet.has(url)) continue;
    const page = pageByUrl.get(url);
    if (!page || page.inboundInternalCount >= WEAK_INLINKS) continue;
    out.push({
      kind: 'sitemap_page_weak_internal_links',
      url,
      gsc: mini(row),
      crawlerEvidence: `This URL is in the site's sitemap but the crawl found only ${page.inboundInternalCount} internal link(s) pointing to it.`,
      searchConsoleEvidence: `Search Console reports ${row.impressions} impression(s) for this URL, so it matters to real searches.`,
      interpretation:
        'A page the site itself lists as important is under-linked internally. Adding contextual internal links makes it easier for crawlers and users to reach.',
    });
  }

  const counts: Record<CorrelationKind, number> = {
    crawl_issue_on_impression_page: 0,
    impressions_but_low_ctr: 0,
    sitemap_page_weak_internal_links: 0,
  };
  for (const c of out) counts[c.kind]++;

  return { correlations: out, counts, pagesWithImpressions };
}

function mini(r: PerfRow): Correlation['gsc'] {
  return { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
}
