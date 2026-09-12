/**
 * Turn a fetch outcome + HTML extraction into the normalized per-page record
 * the crawler stores (`CrawlPage`). Computes indexability / crawlability and the
 * duplicate + security signals (PAGE ANALYSIS checklist).
 */
import type { ExtractedPage } from './html.js';
import type { FetchOutcome } from './fetch.js';
import { analyzeSecurityHeaders } from './security-headers.js';
import { normalizeUrl } from './url.js';

export interface PageRecord {
  url: string;
  normalizedUrl: string;
  depth: number;
  discoveredVia: string;

  httpStatus: number | null;
  finalUrl: string | null;
  redirectChain: Array<{ from: string; to: string; status: number }>;
  fetchError: string | null;
  contentType: string | null;
  htmlBytes: number | null;
  responseTimeMs: number | null;
  renderedWithJs: boolean;

  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  canonicalUrl: string | null;
  canonicalIsSelf: boolean | null;
  noindex: boolean;
  robotsBlocked: boolean;
  indexable: boolean;
  indexabilityReason: string | null;
  crawlable: boolean;

  lang: string | null;
  hreflang: Array<{ hreflang: string; href: string }>;
  h1Count: number;
  headingOutline: Array<{ level: number; text: string }>;
  wordCount: number | null;
  contentHash: string | null;
  simhash: string | null;
  ogTags: Record<string, string>;
  twitterTags: Record<string, string>;
  jsonLdTypes: string[];
  jsonLdErrors: Array<{ index: number; message: string }>;
  jsonLdEntities: Array<{
    type: string;
    name: string | null;
    url: string | null;
    id: string | null;
    sameAs: string[];
  }>;
  viewportMeta: boolean;
  landmarkCount: number;
  hasMainLandmark: boolean;

  imagesTotal: number;
  imagesMissingAlt: number;
  imagesMissingDim: number;

  internalLinkCount: number;
  externalLinkCount: number;

  isHttps: boolean;
  securityHeaders: ReturnType<typeof analyzeSecurityHeaders> | Record<string, never>;
  mixedContent: boolean;

  csrLikely: boolean;
  staticWordCount: number | null;
  renderedWordCount: number | null;

  /** Outbound edges for the link graph (persisted to `CrawlLink`). */
  outboundLinks: Array<{
    toNormalizedUrl: string;
    isInternal: boolean;
    isNofollow: boolean;
    rel: string | null;
    anchorText: string;
  }>;
}

export interface EvaluateInput {
  requestedUrl: string;
  normalizedUrl: string;
  depth: number;
  discoveredVia: string;
  fetch: FetchOutcome;
  /** Static extraction (always present when the fetch returned HTML). */
  extracted: ExtractedPage | null;
  /** Extraction of the rendered DOM, when a headless render ran. */
  rendered: ExtractedPage | null;
  responseTimeMs: number | null;
  /** robots.txt verdict for this URL's path (true ⇒ allowed to crawl). */
  robotsAllowed: boolean;
}

export function evaluatePage(input: EvaluateInput): PageRecord {
  const { fetch: f } = input;
  const base: Partial<PageRecord> = {
    url: input.requestedUrl,
    normalizedUrl: input.normalizedUrl,
    depth: input.depth,
    discoveredVia: input.discoveredVia,
    redirectChain: f.redirects,
    responseTimeMs: input.responseTimeMs,
    crawlable: input.robotsAllowed,
    robotsBlocked: !input.robotsAllowed,
    hreflang: [],
    headingOutline: [],
    ogTags: {},
    twitterTags: {},
    jsonLdTypes: [],
    jsonLdErrors: [],
    jsonLdEntities: [],
    landmarkCount: 0,
    hasMainLandmark: false,
    outboundLinks: [],
    imagesTotal: 0,
    imagesMissingAlt: 0,
    imagesMissingDim: 0,
    internalLinkCount: 0,
    externalLinkCount: 0,
    h1Count: 0,
    viewportMeta: false,
    csrLikely: false,
    securityHeaders: {},
    mixedContent: false,
    renderedWithJs: Boolean(input.rendered),
  };

  if (!f.ok) {
    return {
      ...(base as PageRecord),
      httpStatus: f.status ?? null,
      finalUrl: f.finalUrl ?? null,
      fetchError: `${f.reason}: ${f.detail}`,
      contentType: null,
      htmlBytes: null,
      title: null,
      titleLength: null,
      metaDescription: null,
      metaDescriptionLength: null,
      metaRobots: null,
      xRobotsTag: null,
      canonicalUrl: null,
      canonicalIsSelf: null,
      noindex: false,
      indexable: false,
      indexabilityReason: `fetch failed (${f.reason})`,
      lang: null,
      wordCount: null,
      contentHash: null,
      simhash: null,
      isHttps: input.requestedUrl.startsWith('https://'),
      staticWordCount: null,
      renderedWordCount: null,
    };
  }

  const ex = input.rendered ?? input.extracted;
  const xRobots = firstHeader(f.headers['x-robots-tag']);
  const xRobotsDirectives = (xRobots ?? '').toLowerCase();
  const headerNoindex = /\bnoindex\b/.test(xRobotsDirectives);
  const metaNoindex =
    (ex?.robotsDirectives ?? []).includes('noindex') ||
    (ex?.robotsDirectives ?? []).includes('none');
  const noindex = headerNoindex || metaNoindex;

  const canonicalIsSelf =
    ex?.canonicalUrl != null ? safeEq(ex.canonicalUrl, input.normalizedUrl) : null;

  const status = f.status;
  const statusOk = status >= 200 && status < 300;
  const indexable = statusOk && !noindex && input.robotsAllowed;
  let reason: string | null = null;
  if (!statusOk) reason = `HTTP ${status}`;
  else if (!input.robotsAllowed) reason = 'blocked by robots.txt';
  else if (headerNoindex) reason = 'X-Robots-Tag: noindex';
  else if (metaNoindex) reason = 'meta robots noindex';
  else if (canonicalIsSelf === false) {
    reason = 'canonical points elsewhere';
    // Still "indexable" in the technical sense, but canonicalized away.
  }

  const sec = analyzeSecurityHeaders(f.finalUrl, f.headers);
  const mixedContent =
    f.finalUrl.startsWith('https://') &&
    (ex?.links.some((l) => l.href.startsWith('http://')) ?? false);

  return {
    ...(base as PageRecord),
    httpStatus: status,
    finalUrl: f.finalUrl,
    fetchError: null,
    contentType: f.contentType,
    htmlBytes: f.bodyBytes,
    renderedWithJs: Boolean(input.rendered),
    title: ex?.title ?? null,
    titleLength: ex?.titleLength ?? null,
    metaDescription: ex?.metaDescription ?? null,
    metaDescriptionLength: ex?.metaDescriptionLength ?? null,
    metaRobots: ex?.metaRobots ?? null,
    xRobotsTag: xRobots,
    canonicalUrl: ex?.canonicalUrl ?? null,
    canonicalIsSelf,
    noindex,
    indexable,
    indexabilityReason: reason,
    lang: ex?.lang ?? null,
    hreflang: ex?.hreflang ?? [],
    h1Count: ex?.h1Count ?? 0,
    headingOutline: ex?.headings ?? [],
    wordCount: ex?.wordCount ?? null,
    contentHash: ex?.contentHash ?? null,
    simhash: ex?.simhash ?? null,
    ogTags: ex?.openGraph ?? {},
    twitterTags: ex?.twitter ?? {},
    jsonLdTypes: ex?.jsonLdTypes ?? [],
    jsonLdErrors: ex?.jsonLdErrors ?? [],
    jsonLdEntities: ex?.jsonLdEntities ?? [],
    landmarkCount: ex?.landmarkCount ?? 0,
    hasMainLandmark: ex?.hasMainLandmark ?? false,
    viewportMeta: ex?.viewportMeta ?? false,
    imagesTotal: ex?.imagesTotal ?? 0,
    imagesMissingAlt: ex?.imagesMissingAlt ?? 0,
    imagesMissingDim: ex?.imagesMissingDimensions ?? 0,
    internalLinkCount: ex?.internalLinks.length ?? 0,
    externalLinkCount: ex?.externalLinks.length ?? 0,
    isHttps: f.finalUrl.startsWith('https://'),
    securityHeaders: sec,
    mixedContent,
    csrLikely: computeCsr(input),
    staticWordCount: input.extracted?.wordCount ?? null,
    renderedWordCount: input.rendered?.wordCount ?? null,
    outboundLinks: (ex?.links ?? [])
      .filter((l) => l.normalizedUrl)
      .map((l) => ({
        toNormalizedUrl: l.normalizedUrl as string,
        isInternal: l.isInternal,
        isNofollow: l.isNofollow,
        rel: l.rel,
        anchorText: l.anchorText,
      })),
  };
}

function computeCsr(input: EvaluateInput): boolean {
  if (input.rendered && input.extracted) {
    // Static was near-empty but the render produced substantial content.
    return (
      input.extracted.wordCount < 60 &&
      input.rendered.wordCount >= input.extracted.wordCount * 3 + 60
    );
  }
  return input.extracted?.csrLikely ?? false;
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function safeEq(a: string, b: string): boolean {
  try {
    return normalizeUrl(a) === normalizeUrl(b);
  } catch {
    return a === b;
  }
}
