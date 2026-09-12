import { describe, expect, it } from 'vitest';
import {
  type DnsLookupFn,
  SsrfError,
  assertSafeUrl,
  isBlockedHostname,
  isBlockedIp,
  parseHttpUrl,
} from './ssrf.js';

const lookupTo =
  (...addresses: string[]): DnsLookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);

describe('isBlockedIp', () => {
  it('blocks IPv4 loopback / private / link-local / metadata / broadcast', () => {
    for (const ip of [
      '127.0.0.1',
      '127.9.9.9',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1', // CGNAT
      '255.255.255.255',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback / ULA / link-local / multicast and mapped-v4 privates', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '2001:db8::1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks embedded-IPv4 privates given in their CANONICAL hex-group form (CRAWLER-SECURITY-AUDIT.md BLOCKER-1)', () => {
    // Node's WHATWG URL parser canonicalizes "::ffff:127.0.0.1" to the
    // hex-group string "::ffff:7f00:1" — the dotted quad is gone. The old
    // embedded-v4 detector was a string regex that only matched the dotted
    // form, so this exact string (what a real parsed URL produces) sailed
    // through unblocked, including cloud metadata via a mapped address.
    for (const ip of [
      '::ffff:7f00:1', // ::ffff:127.0.0.1 (loopback), hex-group form
      '::ffff:a9fe:a9fe', // ::ffff:169.254.169.254 (cloud metadata), hex-group form
      '::ffff:c0a8:1', // ::ffff:192.168.0.1 (private), hex-group form
      '64:ff9b::a9fe:a9fe', // NAT64-mapped cloud metadata
      '2002:0a00:0001::', // 6to4-mapped 10.0.0.1
      '2002:a9fe:a9fe::', // 6to4-mapped 169.254.169.254
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows embedded-IPv4-mapped/6to4/NAT64 addresses whose embedded v4 is public', () => {
    for (const ip of ['::ffff:0808:0808', '2002:0808:0808::', '64:ff9b::0808:0808']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost forms and internal suffixes', () => {
    for (const h of [
      'localhost',
      'LOCALHOST',
      'foo.local',
      'db.internal',
      'api.home.arpa',
      'metadata.google.internal',
    ]) {
      expect(isBlockedHostname(h), h).toBe(true);
    }
    expect(isBlockedHostname('example.com')).toBe(false);
  });

  it('blocks a literal private IP given as the hostname', () => {
    expect(isBlockedHostname('127.0.0.1')).toBe(true);
    expect(isBlockedHostname('[::1]')).toBe(true);
  });

  it('blocks a mapped-IPv6 bracketed hostname exactly as it comes out of parseHttpUrl (end-to-end)', () => {
    // Proves the FULL pipeline, not just the isBlockedIp unit — a future change
    // to the canonicalization assumption (e.g. a Node upgrade) is caught here.
    for (const raw of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[2002:0a00:0001::]/',
    ]) {
      const hostname = parseHttpUrl(raw).hostname;
      expect(isBlockedHostname(hostname), `${raw} -> ${hostname}`).toBe(true);
    }
  });

  it('blocks non-canonical numeric IP encodings (decimal / hex / octal / short)', () => {
    for (const h of [
      '2130706433', // decimal for 127.0.0.1
      '0x7f000001', // hex
      '0x7f.0x0.0x0.0x1', // dotted hex
      '0177.0.0.01', // octal
      '127.1', // short form
      '0', // 0.0.0.0
    ]) {
      expect(isBlockedHostname(h), h).toBe(true);
    }
    // real domains that merely contain digits are unaffected
    expect(isBlockedHostname('c10.example.com')).toBe(false);
    expect(isBlockedHostname('123.example.com')).toBe(false);
  });
});

describe('parseHttpUrl', () => {
  it('rejects non-http schemes and non-80/443 ports', () => {
    expect(() => parseHttpUrl('ftp://example.com')).toThrow(SsrfError);
    expect(() => parseHttpUrl('file:///etc/passwd')).toThrow(SsrfError);
    expect(() => parseHttpUrl('http://example.com:8080')).toThrow(SsrfError);
    expect(() => parseHttpUrl('http://example.com:22')).toThrow(SsrfError);
    expect(parseHttpUrl('https://example.com:443/x').hostname).toBe('example.com');
  });
});

describe('assertSafeUrl', () => {
  it('accepts a public host and pins the resolved IP', async () => {
    const res = await assertSafeUrl('https://example.com/page', {
      lookup: lookupTo('93.184.216.34'),
    });
    expect(res.addresses[0]?.address).toBe('93.184.216.34');
  });

  it('refuses when DNS resolves to a private address', async () => {
    await expect(
      assertSafeUrl('https://sneaky.example/', { lookup: lookupTo('10.0.0.5') }),
    ).rejects.toMatchObject({ reason: 'blocked_ip' });
  });

  it('refuses a mixed public/private DNS answer (rebinding shape)', async () => {
    await expect(
      assertSafeUrl('https://rebind.example/', { lookup: lookupTo('93.184.216.34', '127.0.0.1') }),
    ).rejects.toMatchObject({ reason: 'mixed_dns' });
  });

  it('refuses localhost and the metadata hostname without any DNS call', async () => {
    const lookup: DnsLookupFn = async () => {
      throw new Error('DNS should not be called');
    };
    await expect(assertSafeUrl('http://localhost/', { lookup })).rejects.toMatchObject({
      reason: 'blocked_host',
    });
    // A literal metadata IP is refused before any DNS work; the exact reason is
    // "blocked_host" (caught by the literal-IP check) but it is always an SsrfError.
    await expect(
      assertSafeUrl('http://169.254.169.254/latest/meta-data/', { lookup }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('refuses a mapped-IPv6 literal target without any DNS call (CRAWLER-SECURITY-AUDIT.md BLOCKER-1)', async () => {
    const lookup: DnsLookupFn = async () => {
      throw new Error('DNS should not be called for a literal IP host');
    };
    await expect(
      assertSafeUrl('http://[::ffff:169.254.169.254]/', { lookup }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('refuses when there are no DNS records', async () => {
    await expect(
      assertSafeUrl('https://nxdomain.example/', { lookup: lookupTo() }),
    ).rejects.toMatchObject({ reason: 'no_dns' });
  });
});
