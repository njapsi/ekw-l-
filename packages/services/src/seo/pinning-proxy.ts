/**
 * A local forward proxy that closes the DNS-rebinding TOCTOU gap in the
 * headless-render path (docs/CRAWLER-SECURITY-AUDIT.md CRITICAL-3).
 *
 * `fetch.ts` defeats DNS rebinding by resolving + validating a hostname
 * ourselves and then PINNING the actual socket connection to that exact
 * validated address (`assertSafeUrl` + undici's `connect.lookup` override). The
 * Playwright renderer's `page.route` interceptor calls `assertSafeUrl` too, but
 * only as a yes/no gate — the real TCP connection is then made by Chromium's
 * own network stack with its OWN independent DNS resolution, never pinned to
 * what we validated. Between our check and Chromium's connect, a hostile or
 * merely misconfigured DNS answer can change, and the rendering browser (which
 * executes JS and can read responses) ends up talking to whatever the second
 * lookup returns.
 *
 * The fix: point the browser context at THIS local proxy
 * (`browser.newContext({ proxy: { server } })`). Chromium then asks the proxy
 * to open each connection by hostname (CONNECT for HTTPS, absolute-form
 * requests for plain HTTP) instead of resolving DNS itself — so WE do the one
 * resolution that matters, and WE choose the literal IP the socket connects
 * to. No dependency, no TLS termination (CONNECT just splices bytes — the
 * browser's TLS handshake still goes end-to-end to the real origin).
 */
import { type Socket, createConnection } from 'node:net';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { createLogger } from '@growth-agent/observability';
import { type DnsLookupFn, SsrfError, assertSafeUrl } from './ssrf.js';
import { FETCH_DEFAULTS } from './fetch.js';

const log = createLogger('seo.pinning-proxy');

/** Injectable upstream TCP connect (tests replace this; production dials the pinned IP for real). */
export type UpstreamConnect = (port: number, pinnedIp: string) => Promise<Socket>;

const defaultUpstreamConnect: UpstreamConnect = (port, pinnedIp) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: pinnedIp, port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

export interface PinningProxyOptions {
  lookup?: DnsLookupFn;
  connectUpstream?: UpstreamConnect;
  /** Byte cap on a relayed plain-HTTP response body. */
  maxBytes?: number;
}

/** Split a CONNECT/Host authority into hostname + port, respecting `[ipv6]:port`. */
function splitAuthority(authority: string): { hostname: string; port: number | null } {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return { hostname: authority, port: null };
    const hostname = authority.slice(0, close + 1); // keep the brackets
    const rest = authority.slice(close + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : null;
    return { hostname, port: Number.isFinite(port) ? port : null };
  }
  const idx = authority.lastIndexOf(':');
  if (idx === -1) return { hostname: authority, port: null };
  const port = Number(authority.slice(idx + 1));
  return { hostname: authority.slice(0, idx), port: Number.isFinite(port) ? port : null };
}

export interface ResolvedTarget {
  pinnedIp: string;
  family: 4 | 6;
}

/**
 * Validate one proxy target (a CONNECT authority or an absolute request URL's
 * host) against the exact same SSRF policy `fetch.ts` enforces, and return the
 * address to pin the socket to. Exported for direct, socket-free unit testing
 * of the authorization decision.
 */
export async function resolveProxyTarget(
  authority: string,
  requiredPort: number,
  scheme: 'http' | 'https',
  opts: { lookup?: DnsLookupFn } = {},
): Promise<ResolvedTarget | null> {
  const { hostname, port } = splitAuthority(authority);
  if (!hostname) return null;
  if (port !== null && port !== requiredPort) return null; // only 80 (http) / 443 (https)
  try {
    const safe = await assertSafeUrl(`${scheme}://${hostname}/`, { lookup: opts.lookup });
    const pin = safe.addresses[0];
    return pin ? { pinnedIp: pin.address, family: pin.family } : null;
  } catch (e) {
    if (e instanceof SsrfError) return null;
    throw e;
  }
}

export class PinningProxy {
  private server = createServer();
  private readonly lookup: DnsLookupFn | undefined;
  private readonly connectUpstream: UpstreamConnect;
  private readonly maxBytes: number;
  private readonly sockets = new Set<Socket>();

  constructor(opts: PinningProxyOptions = {}) {
    this.lookup = opts.lookup;
    this.connectUpstream = opts.connectUpstream ?? defaultUpstreamConnect;
    this.maxBytes = opts.maxBytes ?? FETCH_DEFAULTS.maxBytes;

    this.server.on(
      'connect',
      (req, clientSocket, head) => void this.handleConnect(req, clientSocket, head),
    );
    this.server.on('request', (req, res) => void this.handleRequest(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
  }

  async start(): Promise<{ port: number }> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('pinning proxy failed to bind a port');
    return { port: addr.port };
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handleConnect(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const authority = req.url ?? '';
    try {
      const target = await resolveProxyTarget(authority, 443, 'https', { lookup: this.lookup });
      if (!target) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      const upstream = await this.connectUpstream(443, target.pinnedIp);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      const cleanup = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.once('error', cleanup);
      clientSocket.once('error', cleanup);
    } catch (e) {
      log.warn({ authority, err: String(e) }, 'CONNECT tunnel refused');
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '';
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    try {
      const target = await resolveProxyTarget(url.host, 80, 'http', { lookup: this.lookup });
      if (!target) {
        res.writeHead(502).end('Blocked');
        return;
      }
      const upstreamReq = httpRequest(
        {
          host: target.pinnedIp,
          port: 80,
          method: req.method,
          path: url.pathname + url.search,
          headers: { ...req.headers, host: url.host },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          let total = 0;
          upstreamRes.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > this.maxBytes) {
              upstreamRes.destroy();
              res.end();
              return;
            }
            res.write(chunk);
          });
          upstreamRes.on('end', () => res.end());
        },
      );
      upstreamReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstreamReq);
    } catch (e) {
      log.warn({ url: rawUrl, err: String(e) }, 'proxied request refused');
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  }
}
