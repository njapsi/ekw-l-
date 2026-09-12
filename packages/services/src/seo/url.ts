/**
 * URL normalization + scope logic for the crawler (docs/SEO-ENGINE.md §1
 * "Normalize"). `normalizeUrl` produces the dedupe + identity key; two request
 * URLs that address the same resource must normalize to the same string.
 *
 * Pure functions only — no I/O, no DNS. SSRF checks live in `ssrf.ts`.
 */
import { wildcardMatch } from './pattern-match.js';

/** Query params that are tracking noise and are dropped during normalization. */
const DEFAULT_STRIP_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  '_ga',
  'igshid',
  'yclid',
];

export interface NormalizeOptions {
  /** Extra query params to strip on top of the tracking defaults. */
  stripParams?: string[];
  /** Keep the URL fragment (`#...`). Default false. */
  keepFragment?: boolean;
  /**
   * Trailing-slash policy for non-root paths:
   * - `preserve` (default): leave as-is
   * - `add`: ensure a trailing slash
   * - `remove`: strip a trailing slash
   */
  trailingSlash?: 'preserve' | 'add' | 'remove';
  /** Drop the query string entirely. Default false. */
  dropQuery?: boolean;
}

export class InvalidUrlError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`Invalid URL "${input}": ${reason}`);
    this.name = 'InvalidUrlError';
  }
}

/** Parse a candidate URL, requiring an http(s) scheme and a host. */
export function parseUrl(input: string, base?: string): URL {
  let u: URL;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    throw new InvalidUrlError(input, 'not a valid absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidUrlError(input, `unsupported scheme "${u.protocol}"`);
  }
  if (!u.hostname) throw new InvalidUrlError(input, 'missing host');
  return u;
}

/**
 * Normalize a URL to its canonical form:
 * - lowercase scheme + host
 * - drop the default port (80/443)
 * - resolve `.`/`..` and collapse `//` in the path (the URL constructor does this)
 * - decode percent-encoding of unreserved characters
 * - sort remaining query params, drop tracking params
 * - strip the fragment (unless `keepFragment`)
 */
export function normalizeUrl(input: string, opts: NormalizeOptions = {}, base?: string): string {
  const u = parseUrl(input, base);

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, ''); // drop FQDN root dot

  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  u.pathname = decodeUnreserved(u.pathname);

  if (!opts.keepFragment) u.hash = '';

  if (opts.dropQuery) {
    u.search = '';
  } else {
    const strip = new Set([...DEFAULT_STRIP_PARAMS, ...(opts.stripParams ?? [])]);
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !strip.has(k.toLowerCase()))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = '';
    for (const [k, v] of params) u.searchParams.append(k, v);
  }

  // Trailing-slash policy (root path always keeps its single slash).
  if (u.pathname !== '/' && opts.trailingSlash && opts.trailingSlash !== 'preserve') {
    if (opts.trailingSlash === 'remove') u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    if (opts.trailingSlash === 'add' && !u.pathname.endsWith('/')) u.pathname += '/';
  }

  return u.toString();
}

/** Decode `%XX` sequences that map to RFC 3986 unreserved chars; leave the rest. */
function decodeUnreserved(path: string): string {
  return path.replace(/%[0-9a-fA-F]{2}/g, (m) => {
    const code = parseInt(m.slice(1), 16);
    const ch = String.fromCharCode(code);
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : m.toUpperCase();
  });
}

/**
 * The registrable domain ("eTLD+1") using a small built-in list of common
 * multi-label public suffixes. This is deliberately not the full Public Suffix
 * List — it covers the cases that matter for same-site scoping and is
 * documented as a limitation.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'co.za',
  'com.mx',
  'co.in',
  'com.sg',
  'com.hk',
]);

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export function sameRegistrableDomain(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

/** Number of non-empty path segments — used for "excessive URL depth". */
export function urlPathDepth(input: string): number {
  try {
    const u = new URL(input);
    return u.pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export interface CrawlBoundary {
  /** The registrable domain the crawl is anchored to. */
  registrableDomain: string;
  /** Extra hostnames explicitly allowed (e.g. `www.` / a CDN subdomain). */
  additionalHosts: string[];
  /** Glob-ish include patterns (`*` wildcard). Empty ⇒ include everything. */
  includePaths: string[];
  /** Glob-ish exclude patterns (`*` wildcard). Applied after include. */
  excludePaths: string[];
}

/** Whether a normalized URL is inside the crawl boundary. */
export function isInScope(normalizedUrl: string, boundary: CrawlBoundary): boolean {
  let u: URL;
  try {
    u = new URL(normalizedUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const hostOk =
    sameRegistrableDomain(host, boundary.registrableDomain) ||
    boundary.additionalHosts.map((h) => h.toLowerCase()).includes(host);
  if (!hostOk) return false;

  const path = u.pathname;
  if (boundary.includePaths.length > 0) {
    const included = boundary.includePaths.some((p) => wildcardMatch(p, path));
    if (!included) return false;
  }
  if (boundary.excludePaths.some((p) => wildcardMatch(p, path))) return false;
  return true;
}
