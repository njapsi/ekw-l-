# PHASE-14-PRODUCTION-CERTIFICATION.md

Master certification record for Phase 14. This is the detailed
audit-evidence trail; `docs/PHASE-14-FINAL-CERTIFICATION.md` is the
concise, formal 26-section report with the scorecard and final verdict.
Read this document for *why* each verdict in that report is what it is.

**Method, stated up front:** this phase followed the brief's own AUDIT →
TEST → FIX → VERIFY → CERTIFY cycle, but this session runs in a sandbox
with **no live Postgres/Redis beyond a prior session's staging setup, no
real YouTube/TikTok/Stripe test credentials, no load-testing
infrastructure, and no SSH access to the live staging host**. Every
finding below is labeled by how it was actually verified:

- **[CODE]** — verified by reading the actual current source code in this
  session, not by trusting a prior phase's documentation.
- **[TEST]** — verified by actually running the test suite / a lint /
  a security gate in this session and observing the real result.
- **[DOC]** — a claim carried forward from a prior phase's audit
  (Phases 14/18/24/25/28/29/31/etc.), not independently re-verified this
  session, cited because it was itself evidence-based when produced.
- **[NOT TESTED]** — requires live infrastructure this sandbox does not
  have. Not fabricated, not assumed passing.

---

## 1. Fresh gate run (this session, [TEST])

- `pnpm lint` — **14/14 packages/apps clean**, 0 errors, 0 warnings.
- `pnpm typecheck` (with dummy `DATABASE_URL`/`DIRECT_URL` for Prisma
  client generation) — **14/14 clean**.
- `pnpm --filter @growth-agent/services test` — **183 test files, 1403
  tests, all passing** in isolation. One test (`missions/crud.test.ts`'s
  "flags, but does not block, activating a mission whose platforms
  overlap another active one") is **confirmed environmentally flaky**:
  it fails with a 5-second timeout only when run concurrently with
  another full-suite-scale test job on this machine, and passes reliably
  every time it's run without that contention (reproduced this exact
  pattern 6+ times across this phase and Phase 12/13's own work). This is
  a real, disclosed test-infrastructure fragility (a timing-sensitive test
  under CPU starvation), not a product bug — but it is worth fixing
  (raising the test's own timeout, or investigating why it's slow) before
  relying on this suite in a resource-constrained CI runner.
- `node scripts/check-tenant-scope.mjs` — **clean**, every tenant model
  checked (including the 21 models Phase 12 found missing from the
  allowlist, and the 2 billing models Phase 13 added).
- `node scripts/audit-allow.mjs` — **clean**, 6 pre-existing allowlisted
  advisories (nodemailer ×5, deepmerge-ts ×1), no new ones.
- `pnpm --filter @growth-agent/web build` — confirmed clean in Phase 13's
  own verification this session (unchanged since); not re-run a third
  time this phase to conserve time, since no web-app code changed between
  then and now.

## 2. Real-data / mock-data sweep (this session, [CODE])

Searched the entire non-test source tree for `mock|fake|dummy|placeholder`
(case-insensitive). Every hit was one of: a deliberate, documented timing
-attack countermeasure (`DUMMY_HASH`/`verifyAgainstDummy` in
`auth/password.ts` — a real security pattern, not fake data); a comment
explicitly stating the code does *not* fabricate data ("never fake
capabilities," "not a placeholder pretending to work"); an HTML `<input
placeholder>` attribute; or an explicitly-labeled UI empty-state component.
**No fabricated analytics, fake API responses, hardcoded dashboard values,
demo users, or simulated integrations were found.** This matches every
prior phase's own repeated finding (Phases 18, 26 both did similar sweeps)
— the "never fabricate" hard rule has held.

## 3. Secret-leak sweep (this session, [CODE])

Searched the entire repository for live-looking secret patterns
(`sk_live_`, `sk_test_[...]`, Google API key shape, GitHub token shape).
13 files matched; **every one** was either the secret-scrubbing regex
definition itself (`observability/scrub.ts`), a test of that scrubbing
logic, or documentation/comments *warning against* pasting a real key
(`.env.staging.example`, `docs/STAGING.md`, `docs/DECISIONS.md`,
`CLAUDE.md`). **No real secret is committed to this repository.** This
also confirms that the live Stripe secret key pasted into this
conversation by the user earlier in this session was correctly never
written to any file, exactly as stated at the time.

## 4. Spot-checked security claims against current code (this session, [CODE])

Rather than trust the extensive prior documentation wholesale (per the
brief's own "do not trust documentation over implementation"), three
high-stakes claims were re-verified by reading the actual current code:

- **Tenant isolation lint** — ran `check-tenant-scope.mjs` fresh (§1);
  genuinely clean against current code, not just documented as clean.
- **AI tool server-side authorization** — read
  `packages/services/src/agent/wordpress-tools.ts` directly: confirmed
  `assertCapabilityUsable(ctx, capabilityId)` and
  `assertGovernanceAllows(ctx.organizationId, 'WORDPRESS', 'analyze', ...)`
  are genuinely called inside the tool's own implementation, not merely
  described in a comment. This is real evidence the "no AI tool may
  bypass normal application authorization" requirement (§11) holds for at
  least this representative tool.
- **Docker `NODE_ENV`** — read `Dockerfile.web`, `Dockerfile.worker`,
  `docker-compose.production.yml` directly: `NODE_ENV=production` is set
  unconditionally in every relevant `ENV`/environment block, confirming
  `AUTH_DEV_LOGIN`'s double-gate is genuinely unreachable in a production
  container, not just documented as such.

## 5. Container hardening state (this session, [CODE])

`docker-compose.production.yml` has `cap_drop: [ALL]` and
`security_opt: ['no-new-privileges:true']` on both `web` and `worker`
(added Phase 12). **`docker-compose.staging.yml` — the file describing
the one environment that is actually live — does not have this
hardening.** This was a deliberate Phase 12 decision at the time (avoid
an unverified change to running infrastructure without redeploy access
that session), but it means the real, deployed staging environment is
running with less container hardening than the production template
describes. **This is a real, open gap**, carried into this phase's
findings (see the scorecard).

## 6. System inventory (§2 of the brief)

The following is a verified-by-reading inventory, not a copy of marketing
claims:

**Frontend** — Next.js 15 App Router, React 19, Tailwind, a Radix-based
`packages/ui` component system. Routes span marketing, auth, onboarding,
the full `/app/*` authenticated shell (YouTube/TikTok/SEO/WordPress/
Agent/Content/Missions/Automations/Reports/Billing/Settings/
Notifications/Knowledge/Research), and a read-only `/admin` console (13
sections). Edge middleware (`middleware.ts` + `config.edge.ts`) gates
`/app`, `/admin`, `/onboarding` on a valid session, adapter-free per
ADR-0011. Error/loading/not-found boundaries exist per-route-group.

**Backend** — Next.js Route Handlers + Server Actions over
`packages/services` (no separate backend framework, ADR-0006). A
dedicated `apps/worker` runs 9 BullMQ queues (`seo-crawl`, `agent-run`,
`report-generation`, `youtube-sync`, `tiktok-sync`,
`search-console-sync`, `content-pipeline`, `automation`, `integrations`,
`billing` — the last added Phase 13) with real repeatable-tick schedulers
for crawl/sync/mission/research/knowledge/billing maintenance.

**Database** — PostgreSQL 16 + Prisma 6, 15 checked-in migrations
(through `20260930120000_billing_v2`, Phase 13), all additive — zero
`DROP TABLE`/destructive column changes across the entire migration
history, confirmed by this being this project's own stated convention and
spot-checked in the two most recent migrations' SQL this session.
Tenant isolation is application-layer (every query scoped by
`organizationId`) backed by the CI lint + integration test suite; Postgres
RLS remains a documented, deferred follow-up (ADR-0035/ADR-0052/ADR-0061)
with a concrete `withTenant()`/`FORCE RLS` design now sketched but not
implemented.

**Infrastructure** — `Dockerfile.web` (Next standalone, non-root,
`HEALTHCHECK /api/health`), `Dockerfile.worker` (Node + Playwright
Chromium, non-root), `docker-compose.production.yml` (web + worker +
Caddy auto-TLS + a one-shot `migrate` service; external managed
Postgres/Redis, no object storage — none is used by any feature).
Staging is **live and deployed** (`https://staging.agentgrowth.tech`,
per this project's own history) on a Hostinger KVM VPS + Supabase
Postgres + Upstash Redis — this session has no credentials to interact
with it directly.

**AI** — `packages/ai` behind a provider-agnostic registry; per-call
timeout/retry/cross-provider-fallback/kill-switch (Phase 22); a Tool
Registry + Policy Engine (Phase 5) as the live dispatch path for
`youtube-growth`/`tiktok-growth`/`wordpress-growth` capabilities; MCP
client/server registry built but not connected to a real external server;
`pgvector`-backed knowledge retrieval (Phase 11) with keyword-fallback
when unconfigured; Growth Missions (Phase 10) as the autonomous
orchestration layer, with a kill switch (`MISSIONS_HALT`, Phase 12) and
weekly publish/content-generation throttles (Phase 12).

**Integrations** — YouTube (Data + Analytics API, OAuth), TikTok (Display
+ Content Posting API, OAuth + PKCE), Google Search Console (shares the
Google OAuth client, provider-aware), a from-scratch SSRF-safe website
crawler (the most adversarially-tested subsystem in this codebase —
Phase 24 found and fixed one BLOCKER and two CRITICALs via live
reproduction), WordPress (Application Password auth). **None of these has
been exercised against a real external account or site in this session**
— every phase since the original integration work has disclosed this
same limitation.

**Commercial** — a 5-tier config-driven plan catalog, a hand-rolled
Stripe REST gateway (no SDK), doubly-idempotent webhooks, layered
entitlements (PLAN → enterprise contract → OVERRIDE/PROMO, Phase 13), an
append-only usage ledger with a new atomic-reservation primitive (Phase
13) proven against a real concurrency race, a credit ledger, and a
pre-downgrade impact check. **No live Stripe test-mode transaction has
ever been run against this deployment.**

## 7. Production environment audit (§3 of the brief)

`scripts/check-env.mjs` is the real, tested (12/12 own tests passing)
mechanism for this — it validates required-vs-optional variables per
target, rejects `http://` in strict mode, requires `rediss://` with a
password, requires at least one working sign-in path, and never echoes a
secret value. **This session has no access to the actual production or
staging `.env` file** to run it against for real — the script itself is
verified correct; whether the *actual deployed* environment passes it is
**[NOT TESTED]** this session.

## 8-39. Per-category findings

See `docs/PHASE-14-FINAL-CERTIFICATION.md`'s scorecard (§40 of the brief)
for the category-by-category PASS / CONDITIONAL PASS / NOT TESTED
verdict and evidence pointer — repeating each category's full reasoning
in both documents would duplicate content without adding value. The
scorecard is the authoritative summary; this document is its evidence
trail.

## What this phase actually fixed

Two real bugs, found by refusing to dismiss an apparent test flake as
"just flaky" (exactly the brief's own "do not trust documentation, verify
the actual system" instruction applied to this session's own recent work,
not just prior phases'):

1. **`missions/crud.test.ts` intermittent timeout** — root-caused, not
   band-aided. `planMission`'s Phase 12 rate-limit check
   (`checkRateLimit`) attempts a real Redis connection
   (`connectTimeout: 3_000`) before falling back open; this test file had
   no Redis mock, so every `planMission` call in it depended on a real
   -network connection attempt failing before proceeding — usually fast,
   occasionally slow enough under system load to exceed vitest's 5s
   default. Fixed by mocking `getObservabilityRedis` in that test file,
   matching `security/rate-limit.test.ts`'s own established pattern.
2. **A genuine financial-correctness bug in the credit ledger**
   (`billing/credits.ts::currentBalance`) — `orderBy: {createdAt: 'desc'}`
   with no tiebreaker returns the wrong row when two transactions share a
   millisecond timestamp (exactly what `grantCredits` immediately
   followed by `consumeCredits` produces), because a stable sort
   preserves insertion order for ties, returning the *older* of the two.
   This would have caused a real, silent stale-balance read in
   production, not just a test artifact. Fixed by adding `id` (a
   time-ordered, tie-free cuid) as a secondary sort key — verified across
   3 consecutive full-suite runs with 0 failures after the fix, having
   reliably reproduced the bug before it.

A brief audit of the same anti-pattern (`orderBy: {createdAt: 'desc'}`
with no tiebreaker) found it in 42 files across the codebase; all but
`credits.ts` were spot-checked or reasoned about and found to be either
`findMany` list displays (where a tie's display order is cosmetic, not a
correctness issue) or a `findFirst` against a column with a real
uniqueness guarantee (`integrations/connections.ts`'s per-org-per
-provider connection lookup, where the `orderBy` can never actually need
to break a tie). No other instance of this pattern was found to share
`credits.ts`'s specific risk shape — a `findFirst` used to compute a
*next* write's value from a *previous* write in the same fast sequence.

No other P0 blockers were found this session requiring a code fix. The
gate-sequence re-verification, mock-data sweep, secret-leak sweep, and
the three targeted code spot-checks (§4) were confirmations, not fixes —
the platform's own extensive prior audit trail (Phases 14, 18, 24, 25,
28, 29, 31) holds up under fresh, skeptical re-inspection for everything
checkable without live infrastructure, and the honest gaps those phases
already disclosed (no live restore drill, no live load test, no live
OAuth/Stripe verification, deferred RLS) remain exactly that — open, not
secretly resolved, not secretly worse.
