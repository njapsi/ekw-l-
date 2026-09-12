import { deflateSync, gzipSync, brotliCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { type RawResponse, type Transport, fetchPage } from './fetch.js';
import type { DnsLookupFn } from './ssrf.js';

const publicDns: DnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

function res(partial: Partial<RawResponse> & { status: number }): RawResponse {
  return {
    headers: { 'content-type': 'text/html' },
    bodyBuffer: Buffer.from(''),
    truncated: false,
    ...partial,
  };
}

describe('fetchPage', () => {
  it('returns the body for an HTML 200', async () => {
    const transport: Transport = async () =>
      res({ status: 200, bodyBuffer: Buffer.from('<html><body>hi</body></html>') });
    const out = await fetchPage('https://example.com/', { transport, lookup: publicDns });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.status).toBe(200);
      expect(out.body).toContain('hi');
      expect(out.isHtml).toBe(true);
    }
  });

  it('follows redirects and records the chain, re-validating each hop', async () => {
    const transport = vi.fn<Transport>(async (req) => {
      if (req.url === 'https://example.com/a')
        return res({ status: 301, headers: { location: '/b' } });
      if (req.url === 'https://example.com/b')
        return res({ status: 200, bodyBuffer: Buffer.from('<html>final</html>') });
      throw new Error(`unexpected ${req.url}`);
    });
    const out = await fetchPage('https://example.com/a', { transport, lookup: publicDns });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.finalUrl).toBe('https://example.com/b');
      expect(out.redirects).toHaveLength(1);
    }
  });

  it('stops with too_many_redirects past the budget', async () => {
    const transport: Transport = async (req) => {
      const n = Number(new URL(req.url).searchParams.get('n') ?? '0');
      return res({ status: 302, headers: { location: `/r?n=${n + 1}` } });
    };
    const out = await fetchPage('https://example.com/r?n=0', {
      transport,
      lookup: publicDns,
      maxRedirects: 3,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('too_many_redirects');
  });

  it('detects a redirect loop', async () => {
    const transport: Transport = async () => res({ status: 302, headers: { location: '/loop' } });
    const out = await fetchPage('https://example.com/loop', { transport, lookup: publicDns });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(['redirect_loop', 'too_many_redirects']).toContain(out.reason);
  });

  it('refuses a redirect that points at a private address', async () => {
    const lookup: DnsLookupFn = async (host) =>
      host === 'internal.example'
        ? [{ address: '10.0.0.9', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    const transport: Transport = async (req) =>
      req.url.includes('example.com')
        ? res({ status: 301, headers: { location: 'https://internal.example/secret' } })
        : res({ status: 200, bodyBuffer: Buffer.from('<html>should not reach</html>') });
    const out = await fetchPage('https://example.com/x', { transport, lookup });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('blocked');
  });

  it('rejects an over-cap decompressed gzip body', async () => {
    const huge = Buffer.alloc(5_000_000, 97);
    const transport: Transport = async () =>
      res({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        bodyBuffer: gzipSync(huge),
      });
    const out = await fetchPage('https://example.com/', {
      transport,
      lookup: publicDns,
      maxBytes: 1_000_000,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('too_large');
  });

  it('does not parse non-textual content types', async () => {
    const transport: Transport = async () =>
      res({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        bodyBuffer: Buffer.from('%PDF'),
      });
    const out = await fetchPage('https://example.com/f.pdf', { transport, lookup: publicDns });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.isHtml).toBe(false);
      expect(out.body).toBe('');
    }
  });

  it('blocks a disallowed scheme up front', async () => {
    const out = await fetchPage('ftp://example.com/', { lookup: publicDns });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('blocked');
  });

  it('a huge RAW (uncompressed) body is truncated in-flight, never fully buffered (resource exhaustion)', async () => {
    // The real transport streams and stops at maxBytes, marking `truncated`.
    // Unlike a decompression bomb, memory use here is already bounded by the
    // byte cap regardless of the server's claimed size, so this is a safe
    // partial result, not a failure.
    const transport: Transport = async () =>
      res({
        status: 200,
        headers: { 'content-type': 'text/html' },
        bodyBuffer: Buffer.alloc(1_000_000, 97), // "a" x 1,000,000
        truncated: true,
      });
    const out = await fetchPage('https://example.com/huge', {
      transport,
      lookup: publicDns,
      maxBytes: 1_000_000,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.truncated).toBe(true);
      expect(out.bodyBytes).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('rejects an over-cap decompressed DEFLATE body (bomb parity with gzip)', async () => {
    const huge = Buffer.alloc(5_000_000, 97);
    const transport: Transport = async () =>
      res({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'deflate' },
        bodyBuffer: deflateSync(huge),
      });
    const out = await fetchPage('https://example.com/', {
      transport,
      lookup: publicDns,
      maxBytes: 1_000_000,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('too_large');
  });

  it('rejects an over-cap decompressed BROTLI body (bomb parity with gzip)', async () => {
    const huge = Buffer.alloc(5_000_000, 97);
    const transport: Transport = async () =>
      res({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'br' },
        bodyBuffer: brotliCompressSync(huge),
      });
    const out = await fetchPage('https://example.com/', {
      transport,
      lookup: publicDns,
      maxBytes: 1_000_000,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('too_large');
  });

  it('maps a transport-level timeout/abort to reason "timeout"', async () => {
    const transport: Transport = async () => {
      throw new Error('The operation was aborted due to timeout');
    };
    const out = await fetchPage('https://example.com/slow', { transport, lookup: publicDns });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('timeout');
  });

  it('maps an ordinary network error to reason "network"', async () => {
    const transport: Transport = async () => {
      throw new Error('ECONNRESET');
    };
    const out = await fetchPage('https://example.com/reset', { transport, lookup: publicDns });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('network');
  });
});
