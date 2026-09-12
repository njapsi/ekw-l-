/**
 * The crawler's HTTP client (docs/SEO-ENGINE.md §1 "Fetch workers", §2). Every
 * fetch:
 *   - passes `assertSafeUrl` (SSRF/rebinding) for the initial URL AND each
 *     redirect hop, and connects PINNED to the validated IP with the real Host
 *   - follows at most `maxRedirects` hops, recording the chain
 *   - strips `Authorization` / `Cookie` on a cross-origin redirect
 *   - streams the body with a hard byte cap and a bounded decompression
 *   - only returns a body for text/html-ish content types
 *
 * There is deliberately no "fetch an arbitrary URL and return the body" export:
 * this is used by the crawl pipeline, which owns scoping + ownership gating.
 */
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type * as Undici from 'undici';
import { createLogger } from '@growth-agent/observability';
import { type DnsLookupFn, SsrfError, assertSafeUrl } from './ssrf.js';

const log = createLogger('seo.fetch');

export const DEFAULT_USER_AGENT =
  'GrowthAgentBot/1.0 (+https://growth-agent.example/bot; technical SEO audit; respects robots.txt)';

export const FETCH_DEFAULTS = {
  maxBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
  timeoutMs: 15_000,
} as const;

export interface RawRequest {
  url: string;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  pinnedIp: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Raw (still possibly compressed) body bytes, already capped at maxBytes. */
  bodyBuffer: Buffer;
  truncated: boolean;
}

/** Injectable transport so tests never open a socket. */
export type Transport = (req: RawRequest) => Promise<RawResponse>;

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export type FetchOutcome =
  | {
      ok: true;
      status: number;
      finalUrl: string;
      redirects: RedirectHop[];
      headers: Record<string, string | string[] | undefined>;
      contentType: string | null;
      body: string;
      bodyBytes: number;
      truncated: boolean;
      isHtml: boolean;
    }
  | {
      ok: false;
      reason:
        'blocked' | 'too_large' | 'timeout' | 'network' | 'too_many_redirects' | 'redirect_loop';
      detail: string;
      /** Present for HTTP-level outcomes reached before failure. */
      status?: number;
      finalUrl?: string;
      redirects: RedirectHop[];
    };

export interface FetchPageOptions {
  lookup?: DnsLookupFn;
  transport?: Transport;
  userAgent?: string;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  method?: 'GET' | 'HEAD';
}

const TEXTUAL_CT =
  /^(?:text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml|application\/(?:ld\+)?json)\b/i;

function baseHeaders(userAgent: string): Record<string, string> {
  return {
    'user-agent': userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en',
    // Ask for no compression; we still defend against a server that ignores it.
    'accept-encoding': 'identity',
  };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

function decodeBody(res: RawResponse, maxBytes: number): { text: string; bytes: number } {
  const enc = String(res.headers['content-encoding'] ?? '')
    .toLowerCase()
    .trim();
  let buf = res.bodyBuffer;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') buf = gunzipSync(buf, { maxOutputLength: maxBytes });
    else if (enc === 'deflate') buf = inflateSync(buf, { maxOutputLength: maxBytes });
    else if (enc === 'br') buf = brotliDecompressSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    if (e instanceof RangeError) throw new DecompressionCapError();
    throw e;
  }
  return { text: buf.toString('utf8'), bytes: buf.length };
}

class DecompressionCapError extends Error {
  constructor() {
    super('decompressed body exceeds the size cap');
    this.name = 'DecompressionCapError';
  }
}

/**
 * Fetch one URL with full SSRF protection and redirect handling.
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchOutcome> {
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const maxBytes = opts.maxBytes ?? FETCH_DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? FETCH_DEFAULTS.maxRedirects;
  const timeoutMs = opts.timeoutMs ?? FETCH_DEFAULTS.timeoutMs;
  const transport = opts.transport ?? undiciTransport;
  const method = opts.method ?? 'GET';

  const redirects: RedirectHop[] = [];
  const visited = new Set<string>();
  let currentUrl = url;
  let carryCredentials = false; // we never send creds, but keep the seam explicit

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let safe;
    try {
      safe = await assertSafeUrl(currentUrl, { lookup: opts.lookup });
    } catch (e) {
      if (e instanceof SsrfError) {
        return { ok: false, reason: 'blocked', detail: e.message, redirects };
      }
      throw e;
    }

    if (visited.has(safe.url.toString())) {
      return {
        ok: false,
        reason: 'redirect_loop',
        detail: `redirect loop back to ${safe.url.toString()}`,
        redirects,
        finalUrl: safe.url.toString(),
      };
    }
    visited.add(safe.url.toString());

    const pin = safe.addresses[0];
    if (!pin) return { ok: false, reason: 'blocked', detail: 'no validated address', redirects };

    const headers = baseHeaders(userAgent);
    if (carryCredentials) {
      // placeholder — the crawler does not authenticate to targets
    }

    let res: RawResponse;
    try {
      res = await transport({
        url: safe.url.toString(),
        method,
        headers,
        pinnedIp: pin.address,
        family: pin.family,
        timeoutMs,
        maxBytes,
      });
    } catch (e) {
      if (e instanceof DecompressionCapError) {
        return { ok: false, reason: 'too_large', detail: e.message, redirects };
      }
      const msg = e instanceof Error ? e.message : 'network error';
      const reason = /timeout|timed out|ETIMEDOUT|aborted/i.test(msg) ? 'timeout' : 'network';
      return { ok: false, reason, detail: msg, redirects };
    }

    const status = res.status;
    const location = pickLocation(res.headers);

    if (status >= 300 && status < 400 && location) {
      let next: string;
      try {
        next = new URL(location, safe.url).toString();
      } catch {
        return {
          ok: false,
          reason: 'network',
          detail: `bad redirect target "${location}"`,
          redirects,
        };
      }
      redirects.push({ from: safe.url.toString(), to: next, status });
      if (hop === maxRedirects) {
        return {
          ok: false,
          reason: 'too_many_redirects',
          detail: `exceeded ${maxRedirects} redirects`,
          redirects,
          finalUrl: next,
        };
      }
      // Strip credentials when leaving the origin (defense-in-depth).
      carryCredentials = carryCredentials && sameOrigin(safe.url.toString(), next);
      currentUrl = next;
      continue;
    }

    // Terminal response.
    const contentType = firstHeader(res.headers['content-type']);
    const isHtml = contentType ? TEXTUAL_CT.test(contentType) : false;
    let body = '';
    let bodyBytes = 0;
    const truncated = res.truncated;
    if (method === 'GET' && isHtml) {
      try {
        const decoded = decodeBody(res, maxBytes);
        body = decoded.text;
        bodyBytes = decoded.bytes;
      } catch (e) {
        if (e instanceof DecompressionCapError) {
          return { ok: false, reason: 'too_large', detail: e.message, redirects, status };
        }
        log.warn({ url: safe.url.toString(), err: String(e) }, 'body decode failed');
      }
    } else {
      bodyBytes = res.bodyBuffer.length;
    }

    return {
      ok: true,
      status,
      finalUrl: safe.url.toString(),
      redirects,
      headers: res.headers,
      contentType,
      body,
      bodyBytes,
      truncated,
      isHtml,
    };
  }

  return {
    ok: false,
    reason: 'too_many_redirects',
    detail: 'redirect budget exhausted',
    redirects,
  };
}

function pickLocation(headers: RawResponse['headers']): string | null {
  return firstHeader(headers['location']);
}
function firstHeader(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// --- Default transport: undici pinned to the validated IP ----------------

let undiciMod: typeof Undici | null = null;
async function getUndici(): Promise<typeof Undici> {
  if (!undiciMod) undiciMod = await import('undici');
  return undiciMod;
}

const undiciTransport: Transport = async (req) => {
  const { Agent, request } = await getUndici();
  // Force the socket to the pre-validated IP; SNI + Host stay the real hostname.
  const dispatcher = new Agent({
    connect: {
      timeout: req.timeoutMs,
      lookup: (
        _hostname: string,
        _options: unknown,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => cb(null, req.pinnedIp, req.family),
    },
    headersTimeout: req.timeoutMs,
    bodyTimeout: req.timeoutMs,
    // Explicit (matches Node's own default) rather than implicit, so the
    // "huge headers" defense is documented and testable
    // (CRAWLER-SECURITY-AUDIT.md — resource exhaustion).
    maxHeaderSize: 16_384,
  });

  try {
    // undici.request does not follow redirects unless told to — we handle each
    // hop ourselves so it stays re-validated.
    const resp = await request(req.url, {
      method: req.method,
      headers: req.headers,
      dispatcher,
      signal: AbortSignal.timeout(req.timeoutMs),
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of resp.body) {
      const b = chunk as Buffer;
      total += b.length;
      if (total > req.maxBytes) {
        truncated = true;
        break;
      }
      chunks.push(b);
    }
    // Drain/close the body if we bailed early.
    if (truncated) resp.body.destroy();

    return {
      status: resp.statusCode,
      headers: resp.headers,
      bodyBuffer: Buffer.concat(chunks),
      truncated,
    };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
};
