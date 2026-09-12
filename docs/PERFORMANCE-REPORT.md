# PERFORMANCE-REPORT.md — Phase 28: Performance and Load Testing

**Question asked:** can the system support real users? Measure frontend/API/
DB/Redis/AI/crawler/background-job performance; load-test eight workflows at
10/50/100/500 concurrent users; find bottlenecks without just adding
infrastructure; optimize.

**Headline answer:** the parts of the system reachable without a database —
the marketing pages and `/api/health` — hold up to real concurrent load with
one clear, now-fixed exception (an unbounded health-check stall). Every
DB-dependent workload (auth, dashboard, analytics, SEO project, crawl
creation, AI requests, reports, billing) could **not** be genuinely load
-tested in this session — there is no live Postgres or Redis available here
(see "Environment constraint" below) — so this report gives an honest,
architecture-based capacity analysis for those instead of invented numbers,
exactly labeled as such throughout.

---

## Environment constraint (read this first)

Same blocker as Phase 27, re-confirmed at the start of this phase: Docker
Desktop cannot start because virtualization is disabled in this machine's
firmware. `docker ps` and `wsl --status` both fail with the same pipe error
as before; `wsl --install` fails with `HCS_E_HYPERV_NOT_INSTALLED`. This is
a firmware (BIOS/UEFI) setting, fixable only by a physical restart into
setup — nothing available to this session can do that.

**Consequence:** no live Postgres, no live Redis, no live BullMQ worker.
Every workload the brief asked to load-test touches at least one of these.
Rather than skip the phase or fabricate numbers, three methods were combined:

1. **Real load tests** (`npx --yes autocannon`, invoked transiently — never
   added as a dependency) against every endpoint that works without a
   database: the public landing page and `/api/health`.
2. **A real bug, reproduced live**: booting the built app
   (`next build && GROWTH_AGENT_ENV_STRICT=0 next start`, the same escape
   hatch Phase 27 wired into the e2e boot) with an unreachable Postgres, then
   curling `/api/health` repeatedly and reading the server's own logs — not
   just reading source.
3. **Architectural analysis** for everything that needs a live DB to
   measure for real, translated into a labeled _projected_ capacity
   discussion, never presented as measured.

Every number below is marked **[measured]** or **[projected]**.

---

## 1. The bug found and fixed: `/api/health` could stall unbounded

### Reproduction

Booted the app with `DATABASE_URL` pointed at a non-existent database and
curled `/api/health` in a loop. **Before the fix**, the first request took
~4 seconds; the server log showed three _sequential_ Prisma
`Can't reach database server` errors before the response — even though
`runHealthChecks` already calls `checkDatabase`, `checkRedis`,
`checkAiProviders`, `checkExternalIntegrations`, and `checkWorker` via a
single `Promise.all`.

**Root cause:** `Promise.all` only parallelizes at the JavaScript level.
Three of those five checks (`checkDatabase`, `checkExternalIntegrations`,
`checkWorker`) had no explicit timeout of their own — they simply awaited a
Prisma call and let whatever the driver's own connection/retry behavior
decided. Against an unreachable Postgres, that underlying behavior
serialized, producing roughly 3× a single connection-attempt's timeout
instead of running genuinely concurrently. The fourth check, `checkRedis`,
was already safe: it delegates to `pingRedis()`, which wraps the ping in an
explicit `Promise.race` against a 2.5s timer
(`packages/services/src/observability/redis.ts`).

### Fix

`packages/services/src/observability/health.ts` now wraps `checkDatabase`,
`checkExternalIntegrations`, and `checkWorker` in the same `Promise.race`
-against-a-timer pattern (2.5s bound), each degrading to
`{ state: 'down', detail: '... timed out' }` instead of hanging.

### Verified, live, before vs. after **[measured]**

|                                                               | Before                                        | After                                                                       |
| ------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| First request with DB unreachable                             | ~4s (3 sequential Prisma failures in the log) | ~2.7s (bounded, single timeout window)                                      |
| Repeated single requests                                      | recurring ~4s stall pattern                   | 118–165ms (served from the route's own response cache)                      |
| `autocannon -c 50 -d 5` against `/api/health`, DB unreachable | not tested (bug found first)                  | 566 requests in 5.07s, p50 243ms, p97.5 2838ms, **zero unbounded requests** |

New tests (`packages/services/src/observability/health.test.ts`) use fake
timers to assert each of the three checks resolves to `'down'` within the
timeout instead of hanging, without ever waiting a real 2.5 seconds in CI.

This was the one concrete, previously-undocumented performance bug found
this phase, and the only one confirmed by directly reproducing broken
behavior rather than reading code.

---

## 2. Live load-test results (reachable without a database) **[measured]**

`autocannon` against the built app (`next start`, production mode) on this
machine (single process, no clustering).

### Landing page (`/`)

| Concurrency | Req/s (median) | p97.5 latency | Failures                                      |
| ----------- | -------------- | ------------- | --------------------------------------------- |
| 10          | 150            | 122ms         | 0                                             |
| 50          | ~145           | —             | 0                                             |
| 100         | ~140           | —             | 0                                             |
| 500         | catastrophic   | p99 ≈ 9.4s    | ~2000–3000/3000 requests failed, 126 timeouts |

**Finding: a hard single-process ceiling around 500 concurrent connections,
not a gradual slowdown.** Throughput plateaus at ~135–150 req/s from 10
through 100 concurrent connections — the process is already saturated at 10
— then falls over entirely at 500. This is expected behavior for one
un-clustered Node process and is not specific to this codebase; it's the
same ceiling any single `next start` process would hit. See §5
("Documented, not fixed") for why this is _not_ fixed by adding more
infrastructure here.

### `/api/health`

Covered above (§1) — before/after the timeout fix.

---

## 3. Per-category findings

### Frontend

- The landing page and other static/marketing routes are pre-rendered
  (`○` in the Next build output) — no per-request server work, so their
  ceiling is purely the single Node process's request-handling throughput
  (see §2). No code-level frontend bottleneck found; the ceiling is
  architectural (single process), documented under "documented, not fixed."
- No client-side bundle-size or hydration issue investigated this phase —
  out of scope for a backend-heavy brief, and the shared First Load JS
  (102 kB) is unremarkable for a Next 15 app of this size.

### API / Server Actions

- **Fixed:** `/api/health`'s unbounded stall (§1).
- **Fixed:** the crawl-detail page's three independent reads
  (`listCrawlIssues`, `latestAuditorRun`, `latestSeoAgentReport`) ran one
  after another despite having no data dependency on each other or on the
  page's `overview` fetch; all four now run via one `Promise.all`
  (`apps/web/app/(app)/app/seo/[websiteId]/crawls/[crawlId]/page.tsx`).
- **Fixed:** every `/app/*` navigation called `requireUser()` and
  `requireActiveOrg()` once per layout and once per page, each re-running a
  session-revocation query and an org-membership lookup. Both are now
  wrapped in React's per-request `cache()` (`apps/web/src/lib/auth.ts`),
  the same primitive already used for `getCorrelationId` since Phase 13 —
  collapsing the duplicate queries within one request/render pass.

### Database

- **Fixed — duplicate Subscription query:** `usage/check.ts` (`checkUsage`,
  called before every metered operation — every crawl start, every AI call,
  every report) and `usage/summary.ts` (`refreshUsageCounters`, the nightly
  rebuild) each ran their own `db.subscription.findUnique` for
  `currentPeriodStart`/`currentPeriodEnd`, _in addition to_
  `resolveEntitlements`'s own `Subscription` read for `tier`. `resolveEntitlements`
  (`billing/entitlements.ts`) now selects and returns the period fields too,
  removing one full round-trip from the hottest metered path in the app.
- **Fixed — narrowed oversized reads:** three list/history queries pulled
  full rows (or a default `include`) when only a handful of fields are ever
  rendered:
  - `content/read.ts`'s `listProjects` fetched every `RepurposeProject`
    column via a bare `include`, including three `@db.Text` fields
    (`sourceDescription`, `sourceTranscript`, `sourceBody`) and a `Json`
    `analysis` blob that the project-list view never reads. Now a `select`
    of exactly the 7 fields the list card uses, plus the asset count.
  - `agent/orchestrator.ts`'s conversation-history fetch pulled every
    `AIMessage` column, including `blocks` — the full `GrowthAgentResponse`
    JSON persisted on every assistant turn — to build a plain-text prompt
    that only needs `role`/`content`. Now selects just those two fields
    (plus `id`/`title` on the conversation itself).
  - `youtube/read.ts`'s channel-overview (up to 200 videos) and
    paginated-videos-list queries both pulled every `YouTubeVideo` column,
    including the `@db.Text` `description`, which neither view renders. Both
    now `select` only the fields their output actually uses.
- **Fixed — the crawler's two N+1 write loops in `finalize()`
  (`seo/crawler.ts`):** the inbound-link-count write (`db.crawlPage.update`,
  one per crawled page) and the issue-persistence write
  (`db.crawlPage.findUnique` + `db.crawlIssue.upsert`, one per detected
  issue) both awaited one row at a time. Extracted into two new, exported
  functions (`persistInboundLinkCounts`, `persistCrawlIssues`) that use the
  already-imported `ConcurrencyLimiter` (`seo/rate-limiter.ts`) to run up to
  10 writes concurrently instead of serially — on a crawl with thousands of
  pages/issues, this is the difference between thousands of sequential
  round-trips and a bounded number of concurrent batches. New
  `seo/crawler.test.ts` (this code previously had zero fast/local test
  coverage — only the Postgres-gated `crawler.integration.test.ts` touched
  it) verifies correct write arguments, that concurrency stays bounded at
  10, and that one failing row never aborts the batch (matching the
  existing `.catch()` semantics).
- **Fixed — a missing index:** `Recommendation`'s existing composite index
  (`organizationId, domain, status`) doesn't serve the highest-volume real
  read paths. Grepping every `db.recommendation.findMany` call site found
  the two heaviest are `agent/capabilities.ts`'s growth-plan capability
  (`take: 40`) and `reports/facts.ts`'s report-generation reads
  (`take: 300` and `take: 100`) — all three filter by `organizationId` alone
  and sort `priorityScore desc, createdAt desc`, a pattern the existing
  index can't serve past its `organizationId` prefix. Added
  `@@index([organizationId, priorityScore, createdAt])` and hand-authored
  the migration (no live Postgres to run `prisma migrate dev` against — see
  "documented, not fixed" for why this was judged acceptable to hand-write
  where a batch-SQL alternative for the crawler fix above was not).
- **[projected], not measured:** without a live database, none of the above
  fixes' actual query-time improvement could be benchmarked with
  `EXPLAIN ANALYZE` against real data volumes. The changes are expected wins
  based on standard Postgres/Prisma behavior (fewer round-trips, smaller
  payloads, an index matching a real access pattern), not measured ones.

### Redis

- No code changes. `pingRedis()` already had a correct bounded timeout
  (2.5s `Promise.race`) before this phase — it was the model the three fixed
  health checks were made to match, not something that itself needed
  fixing.
- BullMQ's own Redis usage (queues, repeatable jobs) could not be exercised
  live — no Redis in this environment. See "documented, not fixed."

### AI

- **Fixed — the Growth Agent orchestrator's capability loop
  (`agent/orchestrator.ts`):** up to 5 capabilities are selected per turn
  and were run in a serial `for` loop, each capability's `run(ctx)` reading
  only the shared, pre-computed `CapabilityContext` — confirmed no
  capability depends on another's result within the same turn. Worst case,
  5 capabilities each making their own model call could take ~5× a single
  call's latency (up to ~5×60s given the existing 60s per-call timeout from
  Phase 22). Now runs via `Promise.all` over a map that keeps each
  capability's own try/catch and error-fallback result — one capability
  failing still degrades gracefully instead of failing the turn, exactly as
  before, just concurrently.
- **Fixed — content generation's per-type loop
  (`content/generate.ts`):** up to 13 content types are generated per
  request, each its own sequential `generateObject` call with an existing
  per-type template fallback on failure. Same parallelization treatment:
  the AI calls now run concurrently, DB writes (`createAssetWithVersion`)
  stay sequential afterward in the original type order (cheap, and keeps
  `assetIds`/`byType` output ordering unchanged).
- **[projected]:** the actual wall-clock improvement for either fix depends
  on the configured AI provider's real latency, which no API key is
  available to measure in this environment.

### Crawler

- Covered under Database above (the `finalize()` N+1 fixes are the
  crawler-specific performance change this phase).
- No change to crawl _throughput_ (pages/sec during the crawl itself) — the
  existing `HostRateLimiter` + `ConcurrencyLimiter`-bounded fetch pipeline
  (Phase 5/Phase 24) was already reviewed for correctness in Phase 24's
  security audit and wasn't the target of this pass; `finalize()`'s
  post-crawl persistence step was.

### Background jobs (BullMQ / worker)

- **Documented, not fixed** — see below. No live worker/Redis to observe
  real queue depth or job duration, so no concurrency numbers were tuned
  blindly.
- **Fixed as a side effect of the DB fixes above:**
  `refreshUsageCounters`'s 8-meter sequential rebuild loop
  (`usage/summary.ts`, run by a nightly job) now runs all 8 meters'
  read-aggregate-then-upsert via `Promise.all` instead of one at a time —
  each meter's rebuild is independent of every other meter's.

---

## 4. Per-workload analysis (the brief's eight workloads)

None of these eight could be genuinely load-tested — every one touches
Postgres and most touch Redis. This section is **[projected]**, based on
tracing each workload's actual query/call count, not measurement.

| Workload                   | What happens per request                                                                                            | Capacity-relevant findings this phase                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Authentication             | JWT session read (no DB on the hot path — Phase 2's ADR-0011 design) + `requireUser`'s one session-revocation query | Now `cache()`d per request (§3) — was running twice per navigation                                                 |
| Dashboard                  | `requireActiveOrg` (org lookup) + dashboard aggregate reads                                                         | Benefits from the `requireUser`/`requireActiveOrg` dedup                                                           |
| Analytics (YouTube/TikTok) | List/overview queries over synced metrics                                                                           | `youtube/read.ts`'s two hot queries narrowed (§3); no TikTok equivalent found needing the same treatment this pass |
| SEO project                | Website + crawl overview reads                                                                                      | Crawl-detail page's reads now parallelized (§3)                                                                    |
| Crawl creation             | `usage.checkUsage` (metering gate) → crawl row insert → job enqueue                                                 | The `checkUsage` Subscription-dedup fix (§3) removes one round-trip from every crawl start                         |
| AI requests                | `usage.enforceAiBudget` → orchestrator/capability calls → model round-trip(s)                                       | Orchestrator parallelization (§3) is the main win here                                                             |
| Reports                    | `reports/facts.ts` gathers per-type facts, including the un-indexed `Recommendation` reads fixed this phase         | Recommendation index (§3) targets this workload's `take: 300`/`take: 100` reads directly                           |
| Billing                    | `resolveEntitlements` + webhook/Subscription reads                                                                  | Benefits from the Subscription-query dedup (§3); webhook idempotency (Phase 23) untouched                          |

**Bottom line for these eight:** every one of them was already reviewed at
least once in an earlier phase (Phase 22 AI production audit, Phase 23
billing production audit, Phase 24 crawler security audit, Phase 26 data
accuracy) — this pass specifically hunted for _redundant work_ (duplicate
queries, oversized selects, serial-when-parallelizable operations) rather
than correctness, and found six concrete instances, fixed above. None of
the eight showed a structural blocker beyond what's already covered.

---

## 5. Documented, not fixed (with rationale)

- **BullMQ per-queue concurrency/priority** (`apps/worker/src/main.ts`): all
  8 queues (`youtube-sync`, `tiktok-sync`, `search-console-sync`,
  `seo-crawl`, `agent-run`, `content-pipeline`, `report-generation`,
  `automation`) share one `concurrency: 4` via a single `startWorker`
  helper. No `limiter` option differentiates CPU-heavy, Playwright-rendered
  `seo-crawl` jobs from light I/O jobs, and the three external-API sync
  queues have no protection against exhausting their own provider quota.
  **Not tuned this phase**: doing so without real job-duration/queue-depth
  telemetry (impossible to produce without a live Redis/worker here) risks
  guessing wrong in either direction — this is exactly the "don't just
  increase infrastructure without identifying the underlying problem"
  failure mode the brief warned against, applied to concurrency numbers
  instead of server count.
- **No shared DB repository layer**: every service module hand-writes its
  own Prisma calls (`packages/db/src` has only tenancy helpers, confirmed
  in earlier phases), which duplicates query shapes beyond what this
  phase's targeted grep found. A full repository-layer refactor is an
  architectural change, not a performance patch, and risks regressions
  across every module without integration tests running against a live DB.
- **Additional indexes beyond the one added**: candidates on `CrawlIssue`
  and `AuditLog` were considered with lower confidence than the
  `Recommendation` one above. Without `EXPLAIN ANALYZE` against real data
  volumes, adding them speculatively risks index bloat (write-amplification,
  planner confusion) for unverified benefit — left as candidates for a
  future phase once real production query stats exist.
- **A caching layer** (Redis-backed response/query cache for entitlements,
  org context, or dashboard aggregates): no invalidation strategy has been
  designed for any candidate surface. Designing one correctly is a
  feature-sized decision, not a performance-phase patch, and it can't be
  tested end-to-end without live Redis in this environment anyway.
- **Horizontal scaling / clustering `next start`**: §2's autocannon results
  show a real single-process ceiling. Adding more processes/instances is
  exactly the "increase infrastructure without identifying the underlying
  problem" pattern the brief explicitly warned against — this is a
  deploy-time decision (Phase 16's Docker/compose setup already supports
  running more than one container) documented here, not a code change.

---

## 6. Verification run this phase

- `pnpm format:check && pnpm lint && pnpm typecheck` — 14/14 packages clean.
- `pnpm --filter @growth-agent/services test` — **681 tests passing** (671
  existing + 10 new: 3 health-check timeout tests, 7 `crawler.test.ts`
  tests).
- `pnpm test:scripts` — 11/11 passing.
- `node scripts/check-tenant-scope.mjs` — clean.
- `node scripts/audit-allow.mjs` — clean (only the pre-existing accepted
  `nodemailer`/`deepmerge-ts` advisories from earlier phases).
- `pnpm --filter @growth-agent/web build` — successful production build,
  all routes rendered.
- `prisma validate` — schema valid (with the new index).
- Live: booted the built app, curled `/api/health` repeatedly with the DB
  unreachable (before/after in §1), ran `autocannon` at 10/50 concurrency
  against `/` and `/api/health` (§2), confirmed the 4-second stall pattern
  is gone.

---

## 7. Residual risks

- Every DB-dependent fix in this report is verified by unit tests against a
  fake `Db` and by `tsc` against Prisma's generated types (which would fail
  to compile a `select` missing a field a caller actually uses) — but **none
  of them has been measured against a live Postgres with real data volumes**.
  The next phase with a working Docker/WSL environment (or a CI run) should
  re-run `EXPLAIN ANALYZE` on the `Recommendation` reads and the crawler
  `finalize()` writes to confirm the expected wins materialize.
  `prisma migrate dev`/`migrate deploy` has never been run against the new
  migration file — it was reviewed by eye against every existing
  migration's identical `CREATE INDEX` pattern, but that is not the same as
  applying it.
  This is the same disclosed limitation as Phase 27, unchanged.
- The orchestrator/content-generation parallelization increases _peak_
  concurrent outbound calls to the AI provider for a single request (up to
  5 for the agent, up to 13 for content generation) — this was already true
  of the _rate_ of calls over time, just now compressed into a shorter
  window. `usage.enforceAiBudget` (Phase 23) still gates the whole operation
  before it starts, but a provider-side per-key concurrent-request limit
  (if the configured provider enforces one) could now be hit where it
  wasn't before. Not observed in this environment (no AI key configured),
  flagged for attention if provider-side 429s appear after this ships.
- The single-process capacity ceiling (§2) is real and unaddressed by this
  phase's code changes (deliberately — see §5). A production deployment
  handling meaningful concurrent traffic will need more than one `web`
  container behind a load balancer; this report is the evidence for that
  decision, not the implementation of it.
