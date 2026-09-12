# CRAWLER-SECURITY-AUDIT.md

Phase 24 — an **adversarial** security audit of the SEO crawler
(`packages/services/src/seo/*` + `apps/worker/src/seo/playwright-renderer.ts`).
The crawler accepts URLs an organization controls and fetches them from our
infrastructure — every finding below was reproduced against the real code in
this repository (not inferred from reading it), then fixed and re-verified. No
probe scripts remain in the tree; the reproduction steps are recorded here so
the exploit is re-derivable without re-running anything unsafe.

Full design reference: `docs/SEO-ENGINE.md` §2, `docs/SECURITY.md` §7.
Decision record: `docs/DECISIONS.md` ADR-0039.

---

## Findings

| #   | Severity     | Area                 | Summary                                                                                                                      | Status                       |
| --- | ------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | **BLOCKER**  | SSRF / IPv6          | IPv4-mapped, 6to4 and NAT64 IPv6 literals bypassed the blocked-IP filter entirely                                            | **Fixed**                    |
| 2   | **CRITICAL** | ReDoS                | robots.txt / crawl-scope wildcard matching used a backtracking regex, exploitable by the crawled site's own robots.txt       | **Fixed**                    |
| 3   | **CRITICAL** | SSRF / DNS rebinding | The headless-render path validated a request's URL but never pinned the browser's actual connection to the validated address | **Fixed**                    |
| 4   | HIGH         | Resource exhaustion  | Duplicate-content clustering is O(n²) in the common case (mostly-distinct pages)                                             | **Fixed** (cheap mitigation) |
| 5   | HIGH         | Resource exhaustion  | The 200,000-page crawl ceiling is independent of the org's billing page budget                                               | Documented, not changed      |

### 1 — BLOCKER: mapped-IPv6 SSRF bypass

**Where:** `packages/services/src/seo/ssrf.ts` `isBlockedIp`.

**The bug.** Node's WHATWG `URL` parser canonicalizes an IPv4-mapped IPv6
literal to its **hex-group** form — `http://[::ffff:127.0.0.1]/` parses to
hostname `[::ffff:7f00:1]`; the dotted quad is gone from the string entirely.
`isBlockedIp`'s embedded-IPv4 detector was a string regex
(`/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/`) that only matches the dotted
spelling, and there was no IPv6 group-range rule for `::ffff:0:0/96` at all —
so the canonical form (the one a real parsed URL actually produces) sailed
through unblocked. The same gap applied to 6to4 (`2002::/16`, embeds a v4
address in bits 16–47) and NAT64 (`64:ff9b::/96`).

**Reproduction (confirmed, then fixed).**

```ts
import { isBlockedHostname, parseHttpUrl } from './ssrf.js';
const h = parseHttpUrl('http://[::ffff:169.254.169.254]/').hostname;
// h === '[::ffff:a9fe:a9fe]'
isBlockedHostname(h); // was: false — BYPASSED. now: true
```

A crawl target, a redirect hop, or a link the crawled site itself supplies,
written as `http://[::ffff:169.254.169.254]/latest/meta-data/iam/security-credentials/`,
reached cloud instance metadata. `2002:0a00:0001::` (6to4 for `10.0.0.1`) and
`64:ff9b::a9fe:a9fe` (NAT64 for `169.254.169.254`) were equally unblocked.

**Fix.** `isBlockedIp` now decodes an embedded IPv4 from the address's
**numeric 16-bit groups** (already computed by `expandIpv6` for every address,
regardless of whether the input string kept a dotted quad or was already
canonicalized to hex groups), covering IPv4-mapped, IPv4-compatible
(deprecated), NAT64, and 6to4 — then recurses into `isBlockedIp` on the
decoded dotted-decimal address. No public API changed.

**Tests:** `ssrf.test.ts` — direct `isBlockedIp` cases for all four
transition mechanisms in their canonical hex-group spelling (not just the
dotted form), an end-to-end `parseHttpUrl → isBlockedHostname` pipeline test,
and an `assertSafeUrl` rejection test.

### 2 — CRITICAL: ReDoS in robots.txt / crawl-scope pattern matching

**Where:** `packages/services/src/seo/robots.ts` (`ruleToRegExp`, now removed)
and `packages/services/src/seo/url.ts` (`globToRegExp`, now removed).

**The bug.** Both translated a `*`-wildcard pattern into a backtracking regex
(`* -> .*`, escaping everything else). A pattern with several `.*` groups
separated by literal text that fails to match causes catastrophic
backtracking.

**Reproduction (confirmed, then fixed).**

```ts
import { parseRobots, matchRobots } from './robots.js';
const robots = `User-agent: *\nDisallow: /${'a*'.repeat(20)}b\n`;
const parsed = parseRobots(robots);
matchRobots(parsed, '/' + 'a'.repeat(35), '*'); // hung past a 15-second kill timeout
```

A ~40-character `Disallow` value, matched against a 35-character path that
doesn't end in `b`, hung the Node process indefinitely. `matchRobots` runs
**once per candidate URL** during a crawl, and robots.txt is 100%
attacker-controlled — it's the crawled site's own file. `includePaths` /
`excludePaths` (org-configured crawl-scope globs) used the identical
`* -> .*` translation and are equally exploitable. The worker runs several
crawl jobs **concurrently in one Node process**
(`apps/worker/src/main.ts`, `concurrency: 4`) — a single-threaded event loop —
so one poisoned robots.txt freezes every other org's in-flight crawl in that
process, not just the attacker's own.

**Fix.** New `packages/services/src/seo/pattern-match.ts`: `wildcardMatch`, the
classic two-pointer glob algorithm (`*` = zero-or-more of any character,
everything else literal), O(n+m) worst case, **no backtracking, no regex, no
escaping needed**. `robots.ts` and `url.ts` both now call it (robots.txt
prefix-vs-`$`-anchored semantics are preserved via a thin wrapper: append a
wildcard for prefix matching, or strip a trailing `$` for exact matching).

**Tests:** new `pattern-match.test.ts` (exact/star-only/multi-star cases plus
the adversarial timing case — resolves in milliseconds, was previously
non-terminating), and a regression test added to both `robots.test.ts` and
`url.test.ts` reproducing the exact hang shape and asserting it now resolves
correctly and fast. All pre-existing wildcard/`$`/prefix-match test cases in
both files still pass unchanged (behavioral parity confirmed).

### 3 — CRITICAL: no DNS-rebinding protection in the headless-render path

**Where:** `apps/worker/src/seo/playwright-renderer.ts`.

**The bug.** `fetch.ts` (the plain HTTP path) defeats DNS rebinding correctly:
resolve + validate a hostname ourselves, then **pin** the actual socket
connection to that exact validated IP (undici's `connect.lookup` override).
The Playwright renderer's `page.route('**/*')` interceptor called
`assertSafeUrl(reqUrl)` too — but only as a yes/no gate. The actual TCP
connection was then made by **Chromium's own network stack**, with its own,
independent DNS resolution, never pinned to what we validated. Between our
check and Chromium's connect, a DNS answer for the target hostname can change
— and rendering is only reachable for a domain whose ownership has already
been verified, which does not mean the tenant is trusted with respect to our
internal infrastructure. A verified-but-malicious tenant can rebind their own
domain's DNS between the check and the render, letting a JS-capable rendered
page reach an internal address. The module's own comment ("a rendered page
cannot be used to reach an internal address") was not actually true.

**Fix.** New `packages/services/src/seo/pinning-proxy.ts` — `PinningProxy`, a
minimal local forward proxy (Node `http`/`net` only, no dependency). Every
Playwright browser context is now created with
`newContext({ proxy: { server: 'http://127.0.0.1:<port>' } })` (Chromium
supports a proxy override **per context**, so the existing singleton browser
instance is unchanged). The proxy:

- On an HTTPS `CONNECT host:port` request: validates the target with the
  **same** `assertSafeUrl` policy `fetch.ts` uses (443 only), then opens the
  upstream TCP connection to the **pinned, validated IP** — never a fresh DNS
  lookup — and splices bytes (`clientSocket.pipe(upstream)` /
  `upstream.pipe(clientSocket)`). TLS is never terminated by the proxy — the
  handshake still goes end-to-end between the browser and the real origin.
- On a plain-HTTP absolute-form request: same validation, forwards via a
  pinned `http.request` with the real `Host` header, relays the response with
  the same byte cap `fetch.ts` uses.
- Refuses with `502` **before** ever attempting an upstream connection when the
  target fails validation.

The existing `page.route` interceptor is kept as a fast first-pass filter and
for non-network resource handling; the proxy is what actually closes the
TOCTOU gap.

**Tests:** new `pinning-proxy.test.ts` — the authorization decision
(`resolveProxyTarget`) is unit-tested directly and exhaustively with no
sockets (private-resolving host refused, public-resolving host pinned to the
exact resolved address, non-standard port refused, a literal blocked IP
refused without calling DNS, the mapped-IPv6 bypass from finding 1 refused as
a CONNECT target too), plus two end-to-end tests that drive real bytes into a
running proxy (CONNECT and plain-HTTP) with the upstream leg mocked — proving
the full server wiring reaches the same decision and pins the mocked upstream
connect call to the exact validated address.

### 4 — HIGH: duplicate-content clustering is O(n²) (fixed as a cheap bonus)

**Where:** `packages/services/src/seo/link-graph.ts` `clusterBySimhash`.

Scanned every existing cluster, linearly, for every page. Most pages on a real
site are **not** near-duplicates of each other, so the cluster list grows
roughly as fast as the page count — making this genuinely O(n²) in the
**common** case, not just an adversarial one. At scale (tens of thousands of
pages, well under the 200,000-page crawl ceiling) this would hang the
finalize step for a very long time — squarely "resource exhaustion via large
numbers of URLs."

**Fix.** Bucket pages by the first 4 hex characters (top 16 bits) of their
simhash before the pairwise Hamming-distance compare — a standard single-band
LSH trade-off. The common (mostly-distinct) case is now near-linear. Trade-off,
documented in code: two near-duplicate pages whose simhash happens to differ
in the top 16 bits are missed — acceptable, this is a heuristic dedup signal,
not a correctness-critical value.

**Tests:** `link-graph.test.ts` — a near-duplicate clustering correctness test
(unchanged from what the old algorithm would produce) plus a bounded-time test
over 4,000 distinct-hash synthetic pages.

### 5 — HIGH: crawl-size ceiling is independent of the plan's page budget (documented, not changed)

`CRAWL_LIMITS.maxPagesCeiling` (200,000) bounds a single crawl request
regardless of the organization's plan `CRAWL_PAGES` budget for the whole
billing period (FREE: 500; CREATOR: 5,000; PRO: 40,000; AGENCY: 200,000— see
`docs/BILLING.md`). `usage.enforceUsage(CRAWL_PAGES)` (Phase 23, ADR-0038) is
a pre-flight **exhaustion gate** — it blocks a _new_ crawl once the budget is
already spent, but does not clamp `maxPages` on a single request to the
_remaining_ budget. A single large crawl can therefore overshoot a plan's
whole-period page budget before the gate has anything to catch. Out of this
audit's scope (it's a plan-enforcement gap, not an SSRF/internal-infrastructure
one) — tracked here and cross-referenced from `docs/BILLING.md`.

---

## Full test matrix (phase brief)

### SSRF / network-restriction targets

| Target                                                                                                            | Status                   | Where enforced / tested                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localhost` (+ `.localhost`, `.localdomain`, `ip6-localhost`)                                                     | ✅ blocked               | `ssrf.ts` `BLOCKED_HOSTNAME_EXACT`/`_SUFFIX`; `ssrf.test.ts`                                                                                                                                                                       |
| `127.0.0.1` / all of `127.0.0.0/8`                                                                                | ✅ blocked               | `isBlockedIp` `BLOCKED_V4_CIDRS`; `ssrf.test.ts`                                                                                                                                                                                   |
| Private IPv4 (`10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10`)                                               | ✅ blocked               | same; `ssrf.test.ts`                                                                                                                                                                                                               |
| Private IPv6 (ULA `fc00::/7`, `::1`, `::`)                                                                        | ✅ blocked               | `isBlockedIp` group checks; `ssrf.test.ts`                                                                                                                                                                                         |
| Link-local (v4 `169.254/16`, v6 `fe80::/10`)                                                                      | ✅ blocked               | same                                                                                                                                                                                                                               |
| Cloud metadata endpoints (`169.254.169.254` incl. all embedded-v6 forms)                                          | ✅ blocked               | finding 1 closes the last gap here                                                                                                                                                                                                 |
| Internal hostnames (`.local`, `.internal`, `.home.arpa`, `metadata.google.internal`, `metadata`, `instance-data`) | ✅ blocked               | `BLOCKED_HOSTNAME_EXACT`/`_SUFFIX`; `ssrf.test.ts`                                                                                                                                                                                 |
| DNS rebinding (mixed public/private answer)                                                                       | ✅ blocked (plain fetch) | `assertSafeUrl` mixed-answer rejection + pinned connect; `ssrf.test.ts`, `fetch.test.ts`                                                                                                                                           |
| DNS rebinding (headless render)                                                                                   | ✅ **fixed this phase**  | finding 3 — `pinning-proxy.ts`                                                                                                                                                                                                     |
| Redirect-based SSRF                                                                                               | ✅ blocked               | every hop re-validated + re-pinned in `fetch.ts`; `fetch.test.ts`                                                                                                                                                                  |
| IPv4/IPv6 "bypass" via alternative representations                                                                | ✅ blocked               | `URL` canonicalizes decimal/hex/octal/short IPv4 forms itself (verified experimentally); `isNumericHostForm` is a defense-in-depth backstop for anything that reaches us non-canonical; embedded-v4-in-v6 forms fixed in finding 1 |
| Non-HTTP protocols (`file:`, `ftp:`, `gopher:`, `data:`, `javascript:`, …)                                        | ✅ blocked               | `parseHttpUrl` scheme allowlist (http/https only); `ssrf.test.ts`                                                                                                                                                                  |

### Resource exhaustion

| Vector                | Status                            | Where enforced / tested                                                                                                                                                                                             |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Huge pages            | ✅ bounded                        | `fetch.ts` streams with a hard byte cap (`maxBytes`, 10 MB default), truncates rather than fully buffering; `fetch.test.ts`                                                                                         |
| Huge headers          | ✅ bounded                        | undici `Agent` `maxHeaderSize` (now explicit, 16 KB — matches Node's platform default)                                                                                                                              |
| Compression bombs     | ✅ bounded                        | `zlib` sync decompress calls pass `maxOutputLength` for gzip **and** deflate **and** brotli; `fetch.test.ts`                                                                                                        |
| Infinite redirects    | ✅ bounded                        | `maxRedirects` (5) + a visited-URL redirect-loop detector; `fetch.test.ts`                                                                                                                                          |
| Large sitemap files   | ✅ bounded                        | 20 MB fetch cap (tighter than the parser's own 50 MB/50k-URL protocol-limit check) + `fast-xml-parser` entity expansion disabled (billion-laughs defense); `sitemap.test.ts`                                        |
| Large numbers of URLs | ✅ bounded (with finding 4 fixed) | sitemap URL cap (5,000 total across all sitemaps, 50,000/file), sitemap-index child cap (20), frontier `maxPages` hard-admission cap; duplicate-clustering O(n²) fixed                                              |
| Slow responses        | ✅ bounded                        | per-request connect/headers/body timeouts + an outer `AbortSignal.timeout`; a transport-level abort/timeout is mapped to a `timeout` outcome; `fetch.test.ts`                                                       |
| Connection exhaustion | ✅ bounded                        | every fetch's `undici.Agent` is closed in a `finally` (no leaked sockets); `ConcurrencyLimiter` bounds in-flight fetches per crawl (≤ 8); the worker's BullMQ `Worker` bounds concurrent crawl jobs per process (4) |

### "Implement" list

| Control              | Status                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network restrictions | ✅ scheme/port allowlist + IP-range table (incl. the fix in finding 1)                                                                                     |
| URL validation       | ✅ `parseHttpUrl` + `assertSafeUrl`, applied to the seed, every redirect hop, every sitemap/sitemap-index URL, and every rendered subresource              |
| Redirect validation  | ✅ every hop re-validated + re-pinned; loop detection; a redirect budget                                                                                   |
| DNS validation       | ✅ resolve ourselves, validate every answer, reject mixed answers, pin the connection (plain fetch **and**, as of this phase, the renderer)                |
| Response limits      | ✅ byte cap, decompressed-size cap, header-size cap, non-text rejection                                                                                    |
| Timeout limits       | ✅ connect/headers/body/outer timeouts per request                                                                                                         |
| Concurrency limits   | ✅ per-crawl `ConcurrencyLimiter` + per-process worker concurrency                                                                                         |
| Crawl limits         | ✅ `maxPages`/`maxDepth`/`maxDurationSec` ceilings, tighter for unverified ownership                                                                       |
| Rate limits          | ✅ per-host minimum delay (`HostRateLimiter`, honors robots.txt `Crawl-delay`); a per-org abuse throttle in front of crawl-start (`SECURITY-AUDIT.md` H-2) |

---

## Residual risk

- 6to4/NAT64/mapped are the well-known, practically-relevant IPv6 transition
  mechanisms that embed an IPv4 address; more exotic or vendor-specific
  encodings are not exhaustively enumerated.
- The pinning proxy covers the two request shapes Chromium actually uses to
  reach the network through an HTTP proxy (CONNECT for TLS, absolute-form for
  plain HTTP). It cannot and does not need to affect `data:`/`blob:`/`file:`
  handling — those aren't network traffic; the existing `page.route` filter
  and Chromium's own local-resource handling already constrain them.
- The proxy cannot apply an application-level byte cap to HTTPS traffic (it
  never terminates TLS, by design — this is what keeps it dependency-free and
  correctness-preserving for the real page load). Defense-in-depth for that
  case is Playwright's own per-page timeout and the crawler's overall
  `maxDurationSec`.
- The O(n²)→bucketed clustering fix (finding 4) is a heuristic trade-off
  (single-band LSH), not a formal proof of equivalence to the old pairwise
  algorithm — acceptable since duplicate-content clustering is already a
  best-effort signal.
- Finding 5 (crawl-size ceiling vs. plan budget) is documented, not fixed —
  tracked for a future billing-aware crawl-planning pass.
- No live-network integration test proves the pinning proxy against a real
  DNS-rebinding timing race (that isn't practical to reproduce deterministically
  in CI); the authorization decision it makes is unit-tested exhaustively
  instead, mirroring how `fetch.test.ts` never exercises the real network
  transport either.

## Verification run

`pnpm format:check && pnpm lint && pnpm typecheck` — clean, 14/14. Full
`packages/services` unit suite green (see `CLAUDE.md` for the current count).
`pnpm --filter @growth-agent/worker typecheck && pnpm --filter
@growth-agent/worker test` — clean. `pnpm --filter @growth-agent/web build` —
clean. `node scripts/check-tenant-scope.mjs` / `node scripts/audit-allow.mjs`
— clean. Findings 1 and 2 were re-verified live after the fix (probe scripts
run once, then deleted): the mapped-metadata hostname now reports blocked, and
the adversarial robots.txt pattern now resolves in under a millisecond instead
of hanging.
