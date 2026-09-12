/**
 * Tests for the DNS-rebinding fix (CRAWLER-SECURITY-AUDIT.md CRITICAL-3). The
 * security-critical decision (`resolveProxyTarget`) is tested directly and
 * exhaustively with no sockets at all — mirroring how `ssrf.test.ts` tests
 * `assertSafeUrl`. Two lightweight end-to-end tests drive real bytes into a
 * running proxy to prove the CONNECT and plain-HTTP wiring both reach that
 * same decision and pin the upstream connection to it (the upstream leg is a
 * spy, never a real socket — exactly how `fetch.test.ts` never calls the real
 * `undiciTransport`).
 */
import { type Socket, connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DnsLookupFn } from './ssrf.js';
import { PinningProxy, resolveProxyTarget } from './pinning-proxy.js';

const lookupTo =
  (...addresses: string[]): DnsLookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);

describe('resolveProxyTarget — the authorization decision', () => {
  it('refuses a CONNECT authority whose DNS resolves to a private address', async () => {
    const res = await resolveProxyTarget('sneaky.example:443', 443, 'https', {
      lookup: lookupTo('10.0.0.5'),
    });
    expect(res).toBeNull();
  });

  it('allows a CONNECT authority that resolves publicly, pinned to that address', async () => {
    const res = await resolveProxyTarget('example.com:443', 443, 'https', {
      lookup: lookupTo('93.184.216.34'),
    });
    expect(res).toEqual({ pinnedIp: '93.184.216.34', family: 4 });
  });

  it('refuses a non-standard port (only 443 for https / 80 for http)', async () => {
    const res = await resolveProxyTarget('example.com:8443', 443, 'https', {
      lookup: lookupTo('93.184.216.34'),
    });
    expect(res).toBeNull();
  });

  it('refuses a literal blocked IP without calling DNS', async () => {
    const lookup = vi.fn();
    const res = await resolveProxyTarget('169.254.169.254:443', 443, 'https', { lookup });
    expect(res).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a mapped-IPv6 literal (the exact BLOCKER-1 bypass) as a CONNECT target', async () => {
    const res = await resolveProxyTarget('[::ffff:169.254.169.254]:443', 443, 'https', {
      lookup: vi.fn(),
    });
    expect(res).toBeNull();
  });

  it('the plain-HTTP form uses port 80 and the http scheme', async () => {
    const blocked = await resolveProxyTarget('internal.local', 80, 'http', {
      lookup: vi.fn(),
    });
    expect(blocked).toBeNull();
    const allowed = await resolveProxyTarget('example.com', 80, 'http', {
      lookup: lookupTo('93.184.216.34'),
    });
    expect(allowed).toEqual({ pinnedIp: '93.184.216.34', family: 4 });
  });
});

describe('PinningProxy — end-to-end wiring', () => {
  let proxy: PinningProxy | null = null;

  afterEach(async () => {
    await proxy?.stop();
    proxy = null;
  });

  function readOnce(socket: Socket): Promise<string> {
    return new Promise((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString())));
  }

  it('CONNECT to a private-resolving host is refused before the upstream connect is ever attempted', async () => {
    const connectUpstream = vi.fn();
    proxy = new PinningProxy({ lookup: lookupTo('10.0.0.5'), connectUpstream });
    const { port } = await proxy.start();

    const client = netConnect(port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));
    const reply = readOnce(client);
    client.write('CONNECT sneaky.example:443 HTTP/1.1\r\nHost: sneaky.example:443\r\n\r\n');
    expect(await reply).toMatch(/502/);
    expect(connectUpstream).not.toHaveBeenCalled();
    client.destroy();
  });

  it('CONNECT to a public-resolving host pins the upstream connect to the validated IP', async () => {
    const fakeUpstream = { pipe: vi.fn(), write: vi.fn(), once: vi.fn(), destroy: vi.fn() };
    const connectUpstream = vi.fn(async () => fakeUpstream as never);
    proxy = new PinningProxy({ lookup: lookupTo('93.184.216.34'), connectUpstream });
    const { port } = await proxy.start();

    const client = netConnect(port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));
    const reply = readOnce(client);
    client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    expect(await reply).toMatch(/200 Connection Established/);
    expect(connectUpstream).toHaveBeenCalledWith(443, '93.184.216.34');
    client.destroy();
  });

  it('a plain-HTTP absolute-form request to a private-resolving host is refused with 502', async () => {
    proxy = new PinningProxy({ lookup: lookupTo('192.168.1.1') });
    const { port } = await proxy.start();

    const client = netConnect(port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));
    const reply = readOnce(client);
    client.write('GET http://internal.example/secret HTTP/1.1\r\nHost: internal.example\r\n\r\n');
    expect(await reply).toMatch(/502/);
    client.destroy();
  });
});
