# SEO-ENGINE.md

Status: **implemented (Phase 5)** in `packages/services/src/seo` +
`apps/web/app/(app)/app/seo` + the `seo-crawl` worker queue. This document is
both the design and the as-built reference; §5 lists what was deferred.

The SEO engine has two parts:

1. **Crawler** — a bounded, robots-aware, **SSRF-safe** fetch/render/extract
   pipeline that produces normalized `CrawlPage` rows and a link graph.
2. **Technical auditor** — rules that evaluate crawl output into ranked
   `CrawlIssue`s and feed the `recommendation` agent.

Goal: make sites easier for search engines, crawlers, AI search systems, and LLM
agents to read. **Never claim any optimization guarantees rankings.**

### As-built module map (Phase 5)

| Concern                                           | Module                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| URL normalization + scope                         | `seo/url.ts`                                                     |
| SSRF / DNS-rebinding guard (authoritative)        | `seo/ssrf.ts` (ADR-0019)                                         |
| Safe HTTP client (redirects, caps, decompression) | `seo/fetch.ts`                                                   |
| robots.txt parse + match                          | `seo/robots.ts`                                                  |
| Sitemap parse (entities off, protocol limits)     | `seo/sitemap.ts`                                                 |
| HTML extraction (cheerio)                         | `seo/html.ts`                                                    |
| Fingerprints (contentHash, simhash)               | `seo/fingerprint.ts`                                             |
| Frontier (in-memory, ADR-0018)                    | `seo/frontier.ts`                                                |
| Per-host rate limit, concurrency, retry/backoff   | `seo/rate-limiter.ts`                                            |
| Render decision + `PageRenderer` seam             | `seo/render.ts` (+ `apps/worker/src/seo/playwright-renderer.ts`) |
| Per-page evaluation                               | `seo/page-eval.ts`                                               |
| Site-architecture analysis                        | `seo/link-graph.ts`                                              |
| Auditor rule catalogue (~39 rules, 9 categories)  | `seo/rules.ts`                                                   |
| Category + overall scoring (published weights)    | `seo/scoring.ts` (ADR-0020)                                      |
| Plan → crawl → finalize orchestration             | `seo/plan.ts`, `seo/crawler.ts`                                  |
| Ownership verification (DNS TXT / HTML file)      | `seo/verify.ts`                                                  |
| SEO Auditor Agent (grounded summary)              | `seo/audit-summary.ts`                                           |
| Kill switch (`CRAWLER_HALT` / per-org)            | `seo/killswitch.ts`                                              |
| Org-scoped reads                                  | `seo/read.ts`                                                    |
| Job entry points (inline now, queue-ready)        | `seo/jobs.ts`                                                    |

---

## 1. Crawler architecture

```
 crawl request ──► plan ──► frontier (Redis) ──► fetch worker(s) ──► render? ──►
 extract ──► normalize ──► persist CrawlPage ──► enqueue new links (depth/limit
 gated) ──► ... ──► finalize ──► auditor
```

- **Plan.** `Crawl.config`: `maxPages`, `maxDepth`, `maxDurationSec`,
  `renderMode` (`STATIC` | `AUTO` | `HEADLESS`), `includePaths`/`excludePaths`
  globs, `respectRobots` (default true; only overridable for a **verified** own
  site, and even then loopback/private targets stay blocked), `concurrency`
  (tier-capped), `crawlDelayMs` (min, honors `robots.txt` `Crawl-delay`).
- **Frontier.** A Redis sorted set per crawl (priority = depth, then discovery
  order) + a Redis set of seen `normalizedUrl` for dedupe. Bounded size; when
  `maxPages` reached, discovery stops, in-flight finishes.
- **Fetch workers.** BullMQ processors in the **network-isolated crawl pool**.
  Per-request: DNS resolve ourselves → validate IP (§3) → connect to the
  resolved IP with `Host` pinned → stream with size cap → record status,
  headers, timing, redirect chain (each hop re-validated).
- **Render decision.** `STATIC`: never launch a browser. `AUTO`: fetch static;
  if the static HTML is near-empty of main content but scripts are present
  (heuristic: low text/DOM ratio + framework markers), re-render with headless
  Chromium (Playwright) under a strict time budget. `HEADLESS`: always render.
  Rendering runs with JS enabled but **no** downloads, popups, geolocation, or
  service workers; a request interceptor applies the same IP/scheme allowlist to
  every subresource.
- **Extract.** From the final (rendered or static) DOM: HTTP status, final URL,
  redirect chain; `<title>`, meta description, meta robots, `rel=canonical`;
  headings + outline; word count; `lang`; `hreflang`; Open Graph; Twitter/X
  card; JSON-LD + microdata (parsed, type-indexed); images (count, missing
  `alt`, missing dimensions, `loading` attr); internal vs external links;
  detected broken links (deferred HEAD check, capped); response timing;
  Core Web Vitals **lab** metrics when headless (labelled lab, not field).
- **Normalize.** URL normalization: lowercase scheme/host, strip default ports,
  resolve `.`/`..`, sort or drop tracking query params (configurable
  allowlist), decode unreserved percent-encoding, strip fragments, optional
  trailing-slash policy. `normalizedUrl` is the dedupe + identity key.
- **Persist.** Extracted data → `CrawlPage` (`@@unique([crawlId,
normalizedUrl])`). Raw HTML (static + rendered) → object storage keyed
  `crawls/{crawlId}/{sha256}.html`, 30-day retention; row keeps `contentHash`.
- **Discover.** New in-scope links → validate → enqueue if under `maxDepth`,
  under `maxPages`, path filters pass, same registrable domain (or an explicit
  additional-host allowlist).
- **Finalize.** Compute crawl-level aggregates (`Crawl.summary`: counts by
  status, depth histogram, orphan set, duplicate clusters, sitemap coverage),
  then enqueue the auditor.

### Discovery inputs

- `robots.txt`: fetched once, parsed, cached on `Website.robotsTxtCache`; rules
  applied per URL; `Sitemap:` directives collected.
- Sitemaps: fetch declared sitemaps + `/sitemap.xml`; follow **sitemap indexes**
  one level; parse `<url>`/`<lastmod>`; cross-check sitemap URLs vs crawled
  (coverage, orphan-in-sitemap, crawled-not-in-sitemap).
- Canonicals and `hreflang` add discovery candidates (still scope-gated).

### Limits & fairness

| Guard                | Default (tier-scaled)      |
| -------------------- | -------------------------- |
| Max pages / crawl    | 500 (Free) → 200k (Agency) |
| Max depth            | 5                          |
| Max duration         | 10 min → 6 h               |
| Per-host concurrency | 2 → 8                      |
| Min crawl delay      | 250 ms (or `robots.txt`)   |
| Max response size    | 10 MB/page                 |
| Max redirects        | 5                          |
| Render time budget   | 15 s/page                  |
| Broken-link checks   | 500/crawl (sampled beyond) |

Crawls also consume the `CRAWL_PAGES` meter (`usage.check` before start,
`usage.record` as pages are fetched; crawl auto-stops at the hard cap).

---

## 2. SSRF & safety (authoritative)

- **Ownership gate:** no crawl beyond a shallow public sample (≤ 10 pages, depth
  ≤ 1, no render) unless `Website.verified = true` via DNS TXT, an uploaded
  HTML token file, or a linked Google Search Console property.
- **IP validation** on the initial URL and **every redirect hop**: resolve DNS
  in-process; reject if any resolved address is loopback, private
  (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`),
  ULA (`fc00::/7`), multicast, or the cloud metadata IP; reject if DNS returns
  mixed public/private. **Also rejects an IPv4 address embedded in an IPv6
  literal** — IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible, NAT64
  (`64:ff9b::/96`), and 6to4 (`2002::/16`) — decoded from the address's numeric
  groups so it catches both the dotted-quad and the hex-group spelling a URL
  parser can produce (Phase 24 fixed a bypass here — see
  `docs/CRAWLER-SECURITY-AUDIT.md` BLOCKER-1). Connect to the **validated IP**
  with SNI/`Host` pinned to defeat DNS rebinding (TOCTOU).
- **Scheme/port:** `http`/`https` only; ports 80/443 only.
- **No credential passthrough:** never forward `Authorization`, cookies, or app
  headers to targets; strip on redirect.
- **Isolation:** crawl/render workers run in a pool whose egress is restricted
  (network policy or forced egress proxy) to the public internet only; they
  hold no app secrets beyond what a crawl needs.
- **Response handling:** stream with a hard byte cap (+ an explicit header-size
  cap); decompression is bounded to the same cap for gzip/deflate/brotli;
  content-type sniffing; reject non-text/non-HTML for parsing (still record
  status).
- **Pattern matching is ReDoS-safe:** robots.txt Allow/Disallow and crawl
  include/exclude path globs use a linear two-pointer wildcard matcher
  (`seo/pattern-match.ts`), not a backtracking regex — a hostile robots.txt is
  100% attacker-controlled and a regex translation of it was exploitable
  (Phase 24 CRITICAL-2).
- **Rendered pages are DNS-rebinding-safe too:** subresource requests pass the
  same `assertSafeUrl` allowlist via a `page.route` interceptor, **and** every
  render's browser context is routed through a local `PinningProxy`
  (`seo/pinning-proxy.ts`) that pins the actual socket to the validated
  address — closing the TOCTOU window a route-interceptor check alone cannot
  (the browser's own DNS resolution happens after that check; Phase 24
  CRITICAL-3).
- **Politeness:** honor `robots.txt` and `Crawl-delay`; identify with a
  descriptive User-Agent + info URL; back off on `429`/`5xx`; a target that
  blocks us → `Crawl.status = BLOCKED` (recorded, **never** evaded).
- **Kill switch:** global + per-org flag to halt crawling.

The engine is explicitly **not** a general fetch proxy: there is no endpoint
that fetches an arbitrary user-supplied URL and returns its body. A full
adversarial audit (localhost/private/link-local/metadata targets, DNS
rebinding, redirect-based SSRF, alternative IP encodings, resource exhaustion)
is in `docs/CRAWLER-SECURITY-AUDIT.md`.

---

## 3. Technical auditor

Consumes `CrawlPage` + link graph + sitemap/robots data. Each rule emits a
`CrawlIssue { code, severity, category, title, detail, evidence,
affectedUrlCount, status }`. Issue identity across crawls =
`(websiteId, code, normalizedUrl?)` so `FIXED`/`REGRESSED` transitions carry
over. Rule catalogue (codes are stable slugs), grouped:

- **Indexability:** `NOINDEX_ON_INDEXABLE_PAGE`, `ROBOTS_BLOCKS_IMPORTANT_PATH`,
  `CANONICAL_TO_NONCANONICAL`, `CANONICAL_CHAIN`, `CANONICAL_SITEMAP_CONFLICT`,
  `ROBOTS_SITEMAP_CONFLICT`, `PARAM_URL_INDEXABLE`.
- **Status & redirects:** `BROKEN_INTERNAL_LINK` (4xx), `SERVER_ERROR` (5xx),
  `REDIRECT_CHAIN` (>1 hop), `REDIRECT_LOOP`, `SOFT_404`, `HTTP_TO_HTTPS_MISSING`,
  `MIXED_CONTENT`.
- **Duplication:** `DUPLICATE_TITLE`, `DUPLICATE_META_DESCRIPTION`,
  `DUPLICATE_CONTENT_CLUSTER` (shingle/simhash), `DUPLICATE_URL_VARIANTS`.
- **Architecture:** `ORPHAN_PAGE` (in sitemap / known but unlinked),
  `EXCESSIVE_CRAWL_DEPTH`, `EXCESSIVE_URL_DEPTH`, `THIN_INTERNAL_LINKING`,
  `FACETED_NAV_EXPLOSION`, `EXCESSIVE_PARAMETERS`.
- **Metadata & semantics:** `MISSING_TITLE`, `TITLE_LENGTH`,
  `MISSING_META_DESCRIPTION`, `MULTIPLE_H1`, `MISSING_H1`, `HEADING_ORDER`,
  `MISSING_IMAGE_ALT`, `MISSING_IMAGE_DIMENSIONS`, `NO_SEMANTIC_LANDMARKS`.
- **Structured data:** `INVALID_JSONLD`, `SCHEMA_TYPE_MISSING_REQUIRED`,
  `OG_TAGS_INCOMPLETE`, `TWITTER_TAGS_INCOMPLETE`, `HREFLANG_INVALID`,
  `HREFLANG_NO_RETURN_TAG`.
- **Rendering & performance:** `CONTENT_REQUIRES_JS` (static vs rendered
  divergence), `CSR_ONLY_MAIN_CONTENT`, `SLOW_RESPONSE`, `LARGE_HTML`,
  `CWV_LAB_LCP`/`CWV_LAB_CLS`/`CWV_LAB_INP` (labelled lab), `NO_VIEWPORT_META`.
- **AI/machine-readability:** `NO_STRUCTURED_DATA`, `AMBIGUOUS_MAIN_CONTENT`,
  `MISSING_CANONICAL_ENTITY_MARKUP`, `CONTENT_NOT_IN_INITIAL_HTML`.

Severity weighting factors: indexability impact, scale (`affectedUrlCount`),
whether it blocks discovery, and confidence. The auditor never asserts a ranking
outcome; it explains machine-readability and crawl-efficiency impact.

---

## 4. Documented limitations (do not fake)

- **Core Web Vitals field data** needs CrUX availability; when absent we report
  only lab metrics, clearly labelled. We do not synthesize field data.
- **JavaScript rendering** is time-bounded and best-effort; a page that exceeds
  the budget keeps its static extraction and is flagged `CONTENT_REQUIRES_JS`
  only when the signal is strong — never guessed. Rendering requires the worker
  (Playwright); the inline crawl path runs `STATIC` only.
- **Bot protection / WAF blocks** end the crawl for that host as `BLOCKED`
  (recorded, never evaded).
- **Third-party sites** cannot be deep-crawled (no ownership) — only the
  shallow public sample (≤ 10 pages, depth ≤ 1, no rendering).
- **"Rankings"** are never predicted or promised. Scores are diagnostic; the
  auditor explains crawl-efficiency and machine-readability impact only.
- **Rich-result eligibility** is not asserted — that depends on Google's own
  rules, not on the presence of markup.
- The **registrable-domain** check uses a small built-in public-suffix list, not
  the full PSL; unusual multi-label TLDs may be treated as separate sites.

## 5. Deferred from Phase 5 (tracked in ROADMAP Phase 6)

- **Raw-HTML archiving** to S3-compatible object storage (`crawls/{id}/{sha}.html`).
- **`CRAWL_PAGES` metering** (`usage.check`/`usage.record`) — the tier ceilings
  are enforced in `schemas.ts` but no meter is charged yet.
- **Network-isolated egress pool** — the SSRF guard is code-level; a dedicated
  worker pool behind an egress proxy is an infra task.
- **Distributed (Redis) frontier** for very large crawls (ADR-0018); today the
  frontier is in-memory and pause/resume re-runs the pass.
- **Deferred broken-link HEAD sampling** beyond links to already-crawled pages.

---

## 6. AI SEO Agent (implemented, Phase 6)

The agent reasons over **already-collected crawler data**. It never crawls a
site itself and it cannot modify a production website (ADR-0021).

### Restricted tools (`seo/agent-tools.ts`)

A closed allowlist of nine **read-only**, org-scoped tools — no write tool
exists:

| Tool                        | Returns (from stored crawl data)                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `seo.get_project`           | the `Website` + its recent crawls                                                                     |
| `seo.get_crawl`             | status, config, category + overall scores, summary aggregates                                         |
| `seo.get_page`              | one `CrawlPage`, or a filtered page list (all / problems / non_indexable)                             |
| `seo.get_issues`            | `CrawlIssue`s, filterable by category / severity / code                                               |
| `seo.get_internal_links`    | inbound/outbound edges for a page; thin-link and top-linked views                                     |
| `seo.get_sitemap`           | declared sitemaps, URL count, parse issues, coverage cross-checks                                     |
| `seo.get_robots`            | parsed robots.txt groups/rules, syntax issues, full-disallow flag                                     |
| `seo.get_schema`            | JSON-LD type histogram, parse errors, no-structured-data share, entity-name consistency               |
| `seo.get_site_architecture` | depth histogram, orphan/non-indexable counts, redirect chains/loops, duplicate clusters, deepest URLs |

`executeSeoTool(name, input, ctx)` is the only entrypoint; it rejects any name
not on the list and Zod-validates the input. Every call is logged on the
`AgentRun`.

### Search Console evidence (Phase 20 — `searchconsole/*`)

When a **verified, selected** Google Search Console property's hostname matches
the crawled site, the agent also gathers Google's own search data (six more
read-only `gsc.*` tools) and adds a `searchConsole` block to its report. It
computes three **deterministic** relationships between the two data sources:

1. a HIGH/CRITICAL crawl issue on a URL that Search Console shows impressions for;
2. a URL with impressions but a click-through rate well below the window median
   (annotated with the crawl's title/meta state);
3. a URL in the sitemap that earns impressions but the crawl found weakly
   internally linked.

Every correlation carries three labelled fields — `crawlerEvidence`,
`searchConsoleEvidence`, `interpretation`. The optional model narrative
(`searchConsoleNote`) must label each sentence the same way and is
grounding-checked against `gsc_*` fact ids; it is dropped if it can't be
grounded. **No Search Console metric is ever synthesised and no ranking outcome
is predicted.** With no matching property the block is `{ connected: false }` and
the agent states it used crawler data only. See `docs/GOOGLE-SEARCH-CONSOLE.md`.

### Recommendation engine (`seo/recommendation-engine.ts`)

Deterministic. Groups issues by `code`, then scores each group 0–100 on six
**published** factors and buckets it into an action plan:

`priorityScore = 100 × ( 0.30·severity + 0.22·reach + 0.16·businessImportance +
0.18·estimatedImpact + 0.08·ease + 0.06·confidence )`

- **severity** — CRITICAL 1.0 … INFO 0.05
- **reach** — `0.3 + 0.7·√(affectedURLs / pagesCrawled)`
- **businessImportance** — per-code table (high/medium/low), plus a small boost
  when the user's stated goals mention the issue's category
- **estimatedImpact** — `categoryImpact × (0.5 + 0.5·reach)`
- **ease** — inverse of implementation difficulty (trivial 1.0 … large 0.25)
- **confidence** — the issue's own confidence

**Action plans:** Quick Wins (high priority + easy), High Impact (high priority +
structural + not trivial), Technical Projects (large-difficulty work), Long-Term
Improvements (everything else worth doing). Each recommendation carries Problem,
Evidence (auditor evidence + affected-URL sample), Why it matters, How to fix it,
Affected pages, Expected benefit, Implementation difficulty and Confidence.
Persisted as `Recommendation` rows (`domain = SEO`, `priorityScore`,
`actionPlan`, `affectedUrlCount`, `businessImportance`).

### Machine-readability analysis (`seo/ai-readability.ts`)

Deterministic 0–100 scores for nine signals — semantic HTML, structured data,
entity consistency, page hierarchy, descriptive URLs, internal links, clear
content relationships, metadata, machine-readable signals — combined into an
overall score with a published per-signal weighting. Each signal (and each
piece of guidance) is labelled **established** (long-standing search-engine
guidance) or **experimental** (AI-search / LLM-agent oriented, still emerging).
The Phase 6 crawl additions `CrawlPage.landmarkCount` / `hasMainLandmark` /
`jsonLdEntities` (and a written-back `inboundInternalCount`) make the semantic
HTML and entity-consistency checks concrete.

### Model use (`seo/agent.ts`)

The model is **optional**. Without an AI provider the agent still produces the
full report — ranked recommendations, action plans, machine-readability
analysis, and a templated executive summary + Q&A answer. With a provider, one
`generateObject` pass refines the wording and answers the user's question,
grounded against a deterministic fact sheet (`checkGroundingFields`, shared with
the other analysts). If the model's free text cannot be grounded after one
repair, it is **dropped** and the deterministic templates are used — the numbers
are unaffected, so nothing unsafe ships. The agent never predicts or promises
rankings.

### Questions it answers

"Why isn't Google finding these pages?", "Which pages are blocked from
crawling?", "Which pages are probably not indexable?", "Where are my canonical
conflicts?", "Which pages are orphaned?", "Which pages should receive internal
links?", "Why does my sitemap contain problematic URLs?", "Which technical SEO
problems should I fix first?", "How should I structure this website for better
machine understanding?", "Which structured data opportunities exist?", "How can
I make my website easier for AI agents to understand?" — all answered from the
crawl data (deterministic fallback answers exist for each shape).
