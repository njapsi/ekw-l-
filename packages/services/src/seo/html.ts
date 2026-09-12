/**
 * HTML analysis (docs/SEO-ENGINE.md "Extract"). Parses a page's HTML with
 * cheerio (tolerant, no script execution) and pulls out everything the PAGE
 * ANALYSIS checklist needs: title, meta, canonical, headings, links, images,
 * structured data, Open Graph / Twitter, language, hreflang, viewport, word
 * count, and a JS-rendering signal.
 *
 * This never fetches anything. `baseUrl` is the page's final URL, used to
 * resolve relative links.
 */
import * as cheerio from 'cheerio';
import { contentHash, simhash } from './fingerprint.js';
import { normalizeUrl, registrableDomain } from './url.js';

export interface HeadingNode {
  level: number;
  text: string;
}

export interface ExtractedLink {
  href: string;
  /** Normalized absolute URL, or null if it could not be resolved/normalized. */
  normalizedUrl: string | null;
  anchorText: string;
  rel: string | null;
  isInternal: boolean;
  isNofollow: boolean;
}

export interface HreflangEntry {
  hreflang: string;
  href: string;
}

export interface JsonLdError {
  index: number;
  message: string;
}

/** A top-level JSON-LD node reduced to its identifying fields. */
export interface JsonLdEntity {
  type: string;
  name: string | null;
  url: string | null;
  id: string | null;
  sameAs: string[];
}

export interface ExtractedPage {
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
  metaRobots: string | null;
  robotsDirectives: string[]; // lowercased tokens: noindex, nofollow, none, noarchive…
  canonicalUrl: string | null;
  lang: string | null;
  viewportMeta: boolean;

  headings: HeadingNode[];
  h1Count: number;
  headingOrderOk: boolean;

  wordCount: number;
  textContent: string;
  contentHash: string;
  simhash: string;

  links: ExtractedLink[];
  internalLinks: ExtractedLink[];
  externalLinks: ExtractedLink[];

  imagesTotal: number;
  imagesMissingAlt: number;
  imagesMissingDimensions: number;

  jsonLd: unknown[];
  jsonLdTypes: string[];
  jsonLdErrors: JsonLdError[];
  jsonLdEntities: JsonLdEntity[];
  microdataTypes: string[];

  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  hreflang: HreflangEntry[];

  /** Semantic-HTML landmarks present (main/nav/header/footer/article/aside/section). */
  landmarkCount: number;
  hasMainLandmark: boolean;

  /** Heuristic: main content likely depends on client-side rendering. */
  csrLikely: boolean;
  scriptCount: number;
  domNodeCount: number;
}

const FRAMEWORK_MARKERS = [
  'id="__next"',
  'id="root"',
  'id="app"',
  'ng-version',
  'data-reactroot',
  'data-server-rendered',
  '__NUXT__',
  'window.__INITIAL_STATE__',
];

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const base = safeUrl(baseUrl);
  const baseHost = base?.hostname ?? '';

  // --- Title / meta ---
  const title = firstNonEmpty($('head > title').first().text());
  const metaDescription = firstNonEmpty($('meta[name="description" i]').attr('content') ?? '');
  const metaRobots = firstNonEmpty($('meta[name="robots" i]').attr('content') ?? '');
  const robotsDirectives = (metaRobots ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const canonicalRaw = firstNonEmpty($('link[rel="canonical" i]').attr('href') ?? '');
  const canonicalUrl = canonicalRaw ? tryNormalize(canonicalRaw, baseUrl) : null;

  const lang = firstNonEmpty($('html').attr('lang') ?? '');
  const viewportMeta = $('meta[name="viewport" i]').length > 0;

  // --- Headings ---
  const headings: HeadingNode[] = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const level = Number(el.tagName.slice(1));
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    headings.push({ level, text });
  });
  const h1Count = headings.filter((h) => h.level === 1).length;
  const headingOrderOk = checkHeadingOrder(headings);

  // --- Body text / fingerprints ---
  const bodyClone = $('body').clone();
  bodyClone.find('script,style,noscript,template,svg').remove();
  const textContent = bodyClone.text().replace(/\s+/g, ' ').trim();
  const wordCount = textContent ? textContent.split(/\s+/).length : 0;

  // --- Links ---
  const links: ExtractedLink[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) return;
    const normalized = tryNormalize(href, baseUrl);
    const relAttr = ($(el).attr('rel') ?? '').toLowerCase().trim() || null;
    const linkHost = normalized ? (safeUrl(normalized)?.hostname ?? '') : '';
    const isInternal = Boolean(
      linkHost && baseHost && registrableDomain(linkHost) === registrableDomain(baseHost),
    );
    links.push({
      href,
      normalizedUrl: normalized,
      anchorText: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 200),
      rel: relAttr,
      isInternal,
      isNofollow: relAttr ? /\bnofollow\b/.test(relAttr) : false,
    });
  });

  // --- Images ---
  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let imagesMissingDimensions = 0;
  $('img').each((_, el) => {
    imagesTotal++;
    const alt = $(el).attr('alt');
    if (alt === undefined) imagesMissingAlt++;
    const hasDim =
      ($(el).attr('width') && $(el).attr('height')) ||
      /(?:^|;)\s*(?:aspect-ratio|width)\s*:/i.test($(el).attr('style') ?? '');
    if (!hasDim) imagesMissingDimensions++;
  });

  // --- Structured data ---
  const jsonLd: unknown[] = [];
  const jsonLdTypes = new Set<string>();
  const jsonLdErrors: JsonLdError[] = [];
  const jsonLdEntities: JsonLdEntity[] = [];
  $('script[type="application/ld+json" i]').each((i, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      jsonLd.push(parsed);
      collectJsonLdTypes(parsed, jsonLdTypes);
      collectJsonLdEntities(parsed, jsonLdEntities);
    } catch (e) {
      jsonLdErrors.push({ index: i, message: e instanceof Error ? e.message : 'invalid JSON' });
    }
  });
  const microdataTypes = new Set<string>();
  $('[itemscope][itemtype]').each((_, el) => {
    const t = ($(el).attr('itemtype') ?? '').split('/').pop();
    if (t) microdataTypes.add(t);
  });

  // --- Semantic landmarks ---
  const landmarkSelector =
    'main, nav, header, footer, article, aside, section[aria-label], section[aria-labelledby], [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"]';
  const landmarkCount = $(landmarkSelector).length;
  const hasMainLandmark = $('main, [role="main"]').length > 0;

  // --- OG / Twitter ---
  const openGraph: Record<string, string> = {};
  $('meta[property^="og:" i]').each((_, el) => {
    const key = ($(el).attr('property') ?? '').toLowerCase();
    const content = $(el).attr('content');
    if (key && content) openGraph[key] = content;
  });
  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:" i]').each((_, el) => {
    const key = ($(el).attr('name') ?? '').toLowerCase();
    const content = $(el).attr('content');
    if (key && content) twitter[key] = content;
  });

  // --- hreflang ---
  const hreflang: HreflangEntry[] = [];
  $('link[rel="alternate" i][hreflang]').each((_, el) => {
    const hl = ($(el).attr('hreflang') ?? '').trim();
    const href = ($(el).attr('href') ?? '').trim();
    if (hl && href) hreflang.push({ hreflang: hl, href });
  });

  // --- Rendering signal ---
  const scriptCount = $('script[src]').length + $('script:not([src])').length;
  const domNodeCount = $('*').length;
  const hasFrameworkMarker = FRAMEWORK_MARKERS.some((m) => html.includes(m));
  const csrLikely = wordCount < 60 && scriptCount >= 3 && (hasFrameworkMarker || domNodeCount < 60);

  const internalLinks = links.filter((l) => l.isInternal);
  const externalLinks = links.filter((l) => !l.isInternal && l.normalizedUrl);

  return {
    title,
    titleLength: title ? title.length : null,
    metaDescription,
    metaDescriptionLength: metaDescription ? metaDescription.length : null,
    metaRobots,
    robotsDirectives,
    canonicalUrl,
    lang,
    viewportMeta,
    headings,
    h1Count,
    headingOrderOk,
    wordCount,
    textContent: textContent.slice(0, 200_000),
    contentHash: contentHash(textContent),
    simhash: simhash(textContent),
    links,
    internalLinks,
    externalLinks,
    imagesTotal,
    imagesMissingAlt,
    imagesMissingDimensions,
    jsonLd,
    jsonLdTypes: [...jsonLdTypes],
    jsonLdErrors,
    jsonLdEntities,
    microdataTypes: [...microdataTypes],
    openGraph,
    twitter,
    hreflang,
    landmarkCount,
    hasMainLandmark,
    csrLikely,
    scriptCount,
    domNodeCount,
  };
}

function firstNonEmpty(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function tryNormalize(href: string, base: string): string | null {
  try {
    return normalizeUrl(href, {}, base);
  } catch {
    return null;
  }
}

function checkHeadingOrder(headings: HeadingNode[]): boolean {
  let prev = 0;
  for (const h of headings) {
    if (prev !== 0 && h.level > prev + 1) return false;
    prev = h.level;
  }
  return true;
}

function collectJsonLdTypes(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdTypes(n, into);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') into.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') into.add(x);
    if (Array.isArray(obj['@graph'])) collectJsonLdTypes(obj['@graph'], into);
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;
}

/** Flatten top-level JSON-LD nodes (and `@graph` members) to identity fields. */
function collectJsonLdEntities(node: unknown, into: JsonLdEntity[]): void {
  if (into.length >= 25) return;
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdEntities(n, into);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) {
    collectJsonLdEntities(obj['@graph'], into);
    return;
  }
  const rawType = obj['@type'];
  const type =
    typeof rawType === 'string'
      ? rawType
      : Array.isArray(rawType) && typeof rawType[0] === 'string'
        ? rawType[0]
        : null;
  if (!type) return;
  const nameField = obj.name ?? obj.headline ?? obj.legalName;
  const sameAsRaw = obj.sameAs;
  const sameAs = Array.isArray(sameAsRaw)
    ? sameAsRaw.filter((x): x is string => typeof x === 'string').slice(0, 10)
    : typeof sameAsRaw === 'string'
      ? [sameAsRaw]
      : [];
  into.push({
    type,
    name: asString(nameField),
    url: asString(obj.url),
    id: asString(obj['@id']),
    sameAs,
  });
}
