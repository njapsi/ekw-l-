import type * as Undici from 'undici';
import {
  IntegrationApiError,
  classifyHttpStatus,
  parseRetryAfter,
  resilientCall,
} from '../integrations/resilience.js';
import { type DnsLookupFn, SsrfError, assertSafeUrl } from '../seo/ssrf.js';
import { restUrl } from './url.js';

/**
 * SSRF-safe HTTP for WordPress (hard rule 7).
 *
 * The site URL is user-supplied, so every request goes through the crawler's
 * `assertSafeUrl` (blocks private / link-local / metadata ranges, mixed DNS
 * answers) and the socket is *pinned* to the validated address — the same
 * resolve-then-pin defence as `seo/fetch.ts`, so DNS rebinding between the
 * check and the connect cannot redirect the request inward.
 *
 * Redirects are never followed: following one would carry the Basic-auth
 * credential to wherever the site points. A redirect is reported to the user
 * with the address they should use instead.
 */

export interface WpAuth {
  username: string;
  password: string;
}

export interface WpRawRequest {
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  pinnedIp: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
}

export interface WpRawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  truncated: boolean;
}

export type WpTransport = (req: WpRawRequest) => Promise<WpRawResponse>;

export interface WpRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string>;
  body?: unknown;
  auth?: WpAuth;
  transport?: WpTransport;
  lookup?: DnsLookupFn;
  timeoutMs?: number;
}

export interface WpResponse<T = unknown> {
  data: T;
  headers: Record<string, string | string[] | undefined>;
}

const MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'GrowthAgent/1.0 (+WordPress REST client)';

function header(h: WpRawResponse['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

export async function wpRequest<T = unknown>(
  siteUrl: string,
  route: string,
  opts: WpRequestOptions = {},
): Promise<WpResponse<T>> {
  const method = opts.method ?? 'GET';
  const url = restUrl(siteUrl, route, opts.query);
  const host = url.host;
  const once = () => wpRequestOnce<T>(url, method, opts);
  return resilientCall(once, {
    provider: 'wordpress',
    breakerKey: `wordpress:${host}`,
    // Only reads are retried. Re-sending a POST after an ambiguous failure
    // could create a second draft or double-apply an update.
    retries: method === 'GET' ? 2 : 0,
    timeoutMs: (opts.timeoutMs ?? 15_000) + 1_000,
  });
}

async function wpRequestOnce<T>(
  url: URL,
  method: 'GET' | 'POST' | 'DELETE',
  opts: WpRequestOptions,
): Promise<WpResponse<T>> {
  let safe;
  try {
    safe = await assertSafeUrl(url.toString(), { lookup: opts.lookup });
  } catch (e) {
    if (e instanceof SsrfError) {
      throw new IntegrationApiError(
        'wordpress',
        'validation',
        'That address points at a private or internal network, which Growth Agent will not contact.',
      );
    }
    throw e;
  }
  const pin = safe.addresses[0];
  if (!pin)
    throw new IntegrationApiError('wordpress', 'network', 'No usable address for the site.');

  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    'accept-encoding': 'identity',
  };
  if (opts.auth) {
    headers.authorization = `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64')}`;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }

  const transport = opts.transport ?? undiciTransport;
  let res: WpRawResponse;
  try {
    res = await transport({
      url: safe.url.toString(),
      method,
      headers,
      body,
      pinnedIp: pin.address,
      family: pin.family,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: MAX_BYTES,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error';
    const kind = /timeout|timed out|aborted/i.test(msg) ? 'timeout' : 'network';
    throw new IntegrationApiError('wordpress', kind, `Could not reach the site: ${msg}`);
  }

  if (res.status >= 300 && res.status < 400) {
    const location = header(res.headers, 'location');
    let target = 'another address';
    try {
      if (location) target = new URL(location, safe.url).origin;
    } catch {
      // Unparseable Location header — the generic wording below still applies.
      target = 'another address';
    }
    throw new IntegrationApiError(
      'wordpress',
      'validation',
      `The site redirected the API request to ${target}. Reconnect using that exact address.`,
      res.status,
    );
  }

  if (res.truncated) {
    throw new IntegrationApiError(
      'wordpress',
      'validation',
      'The site returned an oversized response.',
    );
  }

  let parsed: unknown;
  try {
    parsed = res.body ? JSON.parse(res.body) : null;
  } catch {
    throw new IntegrationApiError(
      'wordpress',
      res.status >= 400 ? classifyHttpStatus(res.status) : 'server',
      `The site did not return WordPress REST API JSON (HTTP ${res.status}). A security plugin, firewall or cache may be blocking /wp-json.`,
      res.status,
    );
  }

  if (res.status >= 400) {
    const err = (parsed ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'error';
    const message = typeof err.message === 'string' ? err.message.slice(0, 300) : '';
    throw new IntegrationApiError(
      'wordpress',
      classifyHttpStatus(res.status),
      `WordPress ${res.status} ${code}${message ? `: ${message}` : ''}`,
      res.status,
      parseRetryAfter(header(res.headers, 'retry-after')),
    );
  }

  return { data: parsed as T, headers: res.headers };
}

// --- Default transport: undici pinned to the validated IP ----------------

let undiciMod: typeof Undici | null = null;
async function getUndici(): Promise<typeof Undici> {
  if (!undiciMod) undiciMod = await import('undici');
  return undiciMod;
}

const undiciTransport: WpTransport = async (req) => {
  const { Agent, request } = await getUndici();
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
    maxHeaderSize: 16_384,
  });
  try {
    const resp = await request(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
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
    if (truncated) resp.body.destroy();
    return {
      status: resp.statusCode,
      headers: resp.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      truncated,
    };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
};
