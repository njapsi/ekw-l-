/**
 * SSRF / DNS-rebinding defense for the crawler (docs/SEO-ENGINE.md §2,
 * docs/SECURITY.md §7). This module is the single authority on "is it safe to
 * connect to this URL". Every initial URL AND every redirect hop must pass
 * `assertSafeUrl` before a socket is opened.
 *
 * Strategy:
 *   1. scheme/port allowlist (http/https, 80/443 only)
 *   2. reject obvious literal-IP and localhost hostnames up front
 *   3. resolve the hostname ourselves (injectable `lookup`) and validate EVERY
 *      returned address against the blocked-range table
 *   4. reject "mixed" DNS answers (some public, some private) — a rebinding tell
 *   5. return the validated addresses so the caller can PIN the connection to a
 *      resolved IP with the Host header set (defeats the resolve→connect TOCTOU)
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly reason:
      'scheme' | 'port' | 'blocked_host' | 'blocked_ip' | 'mixed_dns' | 'no_dns' | 'dns_error',
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver so tests never touch the network. */
export type DnsLookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemDnsLookup: DnsLookupFn = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));
};

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443']);

/** Hostnames that must never be resolved or contacted. */
const BLOCKED_HOSTNAME_EXACT = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // AWS/GCP/Azure/OpenStack metadata & DigitalOcean/Alibaba etc.
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

const BLOCKED_HOSTNAME_SUFFIX = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

/**
 * Parse + validate scheme/port only (no DNS). Throws `SsrfError` for a bad
 * scheme/port or an obviously-internal literal hostname.
 */
export function parseHttpUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new SsrfError(`Not a valid URL: ${input}`, 'blocked_host');
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    throw new SsrfError(`Scheme "${u.protocol}" is not allowed (http/https only).`, 'scheme');
  }
  if (!ALLOWED_PORTS.has(u.port)) {
    throw new SsrfError(`Port "${u.port}" is not allowed (80/443 only).`, 'port');
  }
  return u;
}

/**
 * A non-canonical numeric IP form: a single integer (`2130706433`), a hex
 * literal (`0x7f000001`), an octal/short dotted form (`0177.0.0.01`, `127.1`).
 * `getaddrinfo` will happily parse these into an address, so we reject them
 * outright and require a real DNS name or a canonical dotted-decimal / bracketed
 * IPv6 literal (SECURITY-AUDIT.md L-2).
 */
function isNumericHostForm(host: string): boolean {
  if (isIP(host) !== 0) return false; // canonical literal — handled by isBlockedIp
  const parts = host.split('.');
  return /[0-9]/.test(host) && parts.every((p) => /^(0x[0-9a-f]+|[0-9]+)$/i.test(p));
}

/** True if a bare hostname string is one we refuse to resolve. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAME_EXACT.has(host)) return true;
  if (BLOCKED_HOSTNAME_SUFFIX.some((s) => host.endsWith(s))) return true;
  if (isNumericHostForm(host)) return true;
  // A literal IP as the hostname is checked with the full IP table.
  if (isIP(host) !== 0 || isBracketedIpv6(host)) {
    return isBlockedIp(stripBrackets(host));
  }
  return false;
}

function isBracketedIpv6(host: string): boolean {
  return host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6;
}
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

// --- IP range checks ------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255 || !/^\d+$/.test(p)) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function inV4(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range ?? '');
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** IPv4 ranges that must never be contacted. */
const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8', // "this host"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (incl. 169.254.169.254 cloud metadata)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved / future use
  '255.255.255.255/32', // broadcast
];

/**
 * True if the address (v4 or v6, possibly IPv4-mapped/compat IPv6) is in a
 * blocked range: loopback, private, link-local, ULA, multicast, metadata, etc.
 */
export function isBlockedIp(address: string): boolean {
  const addr = address.toLowerCase().replace(/%.*$/, ''); // drop zone id
  const family = isIP(addr);

  if (family === 4) {
    return BLOCKED_V4_CIDRS.some((c) => inV4(addr, c));
  }
  if (family !== 6) return true; // not a valid IP → refuse

  const groups = expandIpv6(addr);
  if (!groups) return true;

  // Embedded-IPv4 transition mechanisms, decoded from the NUMERIC groups
  // (not a string regex on the dotted quad). This matters because Node's
  // WHATWG URL parser (and `dns.lookup`) canonicalizes "::ffff:127.0.0.1" to
  // the hex-group form "::ffff:7f00:1" — the dotted quad is gone from the
  // string entirely. A string-based embedded-quad regex never fires on that
  // canonical form, which let cloud-metadata / loopback / private addresses
  // through disguised as a mapped or 6to4/NAT64 IPv6 literal
  // (CRAWLER-SECURITY-AUDIT.md BLOCKER-1). Deriving from `groups` is correct
  // for both the dotted-quad and hex-group string spellings, since
  // `expandIpv6` already folds a trailing dotted quad into hex groups above.
  const embeddedV4 = extractEmbeddedIpv4(groups);
  if (embeddedV4 && isBlockedIp(embeddedV4)) return true;

  const first = groups[0] ?? 0;
  // ::/128 unspecified, ::1/128 loopback
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique local (ULA)
  if ((first & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation
  if (first === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
}

/**
 * Decode an IPv4 address embedded in an IPv6 address, from its 8 numeric
 * 16-bit groups. Recognizes the well-known transition mechanisms that matter
 * for SSRF: IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::0.0.0.0/96`,
 * deprecated), NAT64 (`64:ff9b::/96`), and 6to4 (`2002::/16`). Returns the
 * dotted-decimal form, or null if no known embedding pattern matches.
 */
function extractEmbeddedIpv4(groups: number[]): string | null {
  const isZero = (arr: number[]) => arr.every((g) => g === 0);
  const toV4 = (hi: number, lo: number): string =>
    [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');

  // ::ffff:0:0/96 — IPv4-mapped, e.g. "::ffff:127.0.0.1" / "::ffff:7f00:1"
  if (isZero(groups.slice(0, 5)) && groups[5] === 0xffff) {
    return toV4(groups[6]!, groups[7]!);
  }
  // ::0.0.0.0/96 — IPv4-compatible (deprecated). Exclude "::" and "::1", which
  // are handled explicitly as unspecified/loopback right after this call.
  if (isZero(groups.slice(0, 6)) && !(groups[6] === 0 && (groups[7] ?? 0) <= 1)) {
    return toV4(groups[6]!, groups[7]!);
  }
  // 64:ff9b::/96 — NAT64 well-known prefix
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && isZero(groups.slice(2, 6))) {
    return toV4(groups[6]!, groups[7]!);
  }
  // 2002::/16 — 6to4, embeds the v4 address in groups[1..2]
  if (groups[0] === 0x2002) {
    return toV4(groups[1]!, groups[2]!);
  }
  return null;
}

/** Expand an IPv6 string to 8 numeric groups, or null if malformed. */
function expandIpv6(addr: string): number[] | null {
  let s = addr;
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4?.[1]) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    const hi = (n >>> 16) & 0xffff;
    const lo = n & 0xffff;
    s = s.slice(0, v4.index) + `${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((x) => x !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((x) => x !== '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (missing < 1) {
    return null;
  }
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ].map((h) => parseInt(h || '0', 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff))
    return null;
  return groups;
}

// --- Public entrypoint --------------------------------------------------

export interface SafeUrlResult {
  url: URL;
  /** Validated addresses from DNS; connect by pinning one of these. */
  addresses: ResolvedAddress[];
}

/**
 * Assert that `input` is safe to fetch. Resolves DNS via `lookup` and validates
 * every answer. Throws `SsrfError` otherwise. On success, returns the parsed URL
 * plus the validated IPs so the caller can pin the socket.
 */
export async function assertSafeUrl(
  input: string,
  opts: { lookup?: DnsLookupFn } = {},
): Promise<SafeUrlResult> {
  const url = parseHttpUrl(input);
  const host = url.hostname.toLowerCase();

  if (isBlockedHostname(host)) {
    throw new SsrfError(`Refusing to contact internal host "${host}".`, 'blocked_host');
  }

  // Literal IP hostname: no DNS, validate directly.
  const literal = stripBrackets(host);
  if (isIP(literal) !== 0) {
    if (isBlockedIp(literal)) {
      throw new SsrfError(`Address ${literal} is in a blocked range.`, 'blocked_ip');
    }
    const family = isIP(literal) === 6 ? 6 : 4;
    return { url, addresses: [{ address: literal, family }] };
  }

  const lookup = opts.lookup ?? systemDnsLookup;
  let records: ResolvedAddress[];
  try {
    records = await lookup(host);
  } catch (e) {
    throw new SsrfError(
      `DNS lookup failed for "${host}": ${e instanceof Error ? e.message : 'unknown'}`,
      'dns_error',
    );
  }
  if (records.length === 0) {
    throw new SsrfError(`No DNS records for "${host}".`, 'no_dns');
  }

  const blocked = records.filter((r) => isBlockedIp(r.address));
  if (blocked.length === records.length) {
    throw new SsrfError(
      `All addresses for "${host}" are in blocked ranges (${blocked
        .map((b) => b.address)
        .join(', ')}).`,
      'blocked_ip',
    );
  }
  if (blocked.length > 0) {
    // Mixed public/private answer — classic DNS-rebinding shape. Refuse entirely.
    throw new SsrfError(
      `"${host}" resolves to both public and private addresses; refusing (possible DNS rebinding).`,
      'mixed_dns',
    );
  }

  return { url, addresses: records };
}
