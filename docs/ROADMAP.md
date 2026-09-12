# ROADMAP.md

Phases are implemented **one at a time**. Each phase ends with: lint, typecheck,
unit tests, integration tests (where applicable), security checks, doc updates,
a change summary, a risk list — then **STOP**. No phase auto-starts the next.

Legend: ✅ done · ⬜ planned

> Note: work is being driven in the order the operator requests it, which does
> not always match this internal roadmap's numbering. The **YouTube growth
> agent** (roadmap "Phase 8") shipped after the web-app foundation; the
> integrations framework it needed was built alongside it. "Phase 3 — Auth &
> tenancy hardening" below is still outstanding.

---

## Phase 0 — Scaffold ✅

Monorepo (pnpm + Turborepo), TS strict, ESLint/Prettier, Vitest/Playwright,
CI. `packages/core` (Result, Claim/Finding/Recommendation/AnalysisReport
schemas, Agent/Orchestrator contracts), `packages/ai` (provider abstraction,
registry, Anthropic/OpenAI/Google, pricing + usage), `packages/db` (Prisma
skeleton: identity, tenancy, billing stub, integrations, agent/recommendation),
`apps/worker` skeleton, `apps/web` shell + landing + `/api/health`. Docs
skeleton + `CLAUDE.md`.

## Phase 1 — Product architecture ✅

Documentation only — no feature implementation. `PRODUCT.md`, `ARCHITECTURE.md`,
`DATABASE.md`, `API.md`, `AI-ARCHITECTURE.md`, `SECURITY.md`, `SEO-ENGINE.md`,
`ROADMAP.md`, `DECISIONS.md`, `CLAUDE.md` finalized: stack decision, 18 modules
(the 17 from the brief + a dedicated `usage` module split out of billing),
normalized schema design, API + AI + crawler + monetization architecture, MVP
boundary, risks, open questions. Consistency-checked across documents.

---

## MVP boundary (recap from `PRODUCT.md` §5)

MVP = Auth + Orgs + RBAC + isolation + audit · Billing (Stripe, tiers, usage
limits) · Integrations (YouTube + Google Search Console; TikTok read-only
stub) · SEO engine (bounded SSRF-safe crawler + core auditor rules) · AI
(abstraction + orchestrator + analyst/auditor/recommendation/reporting agents,
structured output, cost tracking) · Recommendations/Tasks/Reports/Notifications
· Dashboard · read-mostly Admin · observability.

Everything else (TikTok deep analytics + publishing, scheduled monitoring,
white-label, content calendar, public API, SSO/SCIM, multi-region) is
**post-MVP**.

---

## Implementation phases (each gated, then STOP)

### Phase 2 — Web application foundation ✅

`packages/ui` (Radix component system + Tailwind preset + tokens),
`packages/observability` (pino + request correlation), `packages/services` with
the `auth`, `rbac`, `organizations`, `users`, and `audit` modules. First
checked-in Prisma migration (identity, tenancy, RBAC, invitations, platform
staff, audit log). Auth.js v5 with **JWT sessions** (ADR-0011), magic-link
(console transport in dev) + Google + a dev-only credentials provider. Edge
middleware route protection; `authorize()` policy table; `withOrgScope`
repositories; `requireUser` / `requireActiveOrg` / `requirePermission` /
`requirePlatformStaff` server helpers with `sessionVersion` revocation. Public
marketing pages (`/`, `/features`, `/pricing`, `/docs`, `/login`, `/signup`),
authenticated app shell with all `/app/*` routes (empty states, no fabricated
data), settings (profile / organization / members with invitations + role
changes), onboarding, invite-accept, read-only `/admin`. Root + segment
`error` / `not-found` / `global-error` / `loading` files, standard API error
envelope, expanded `/api/health` (process + DB checks). Unit tests (RBAC,
errors, auth callbacks, slug, correlation, cn), DB integration test (tenant
isolation, self-skips without a database), Playwright smoke (public pages, route
protection, health, mobile). `docker-compose.yml` (Postgres + Redis + MinIO +
Mailpit); CI runs migrations, integration tests, and e2e against a Postgres
service.

**Carried forward:** Postgres Row-Level Security policies; auth/endpoint rate
limiting; invitation email (needs the notifications module); Sentry + OTel/
metrics export wiring.

### Phase 3 — Auth & tenancy hardening — partly ✅

Postgres RLS on every tenant table (`app.current_org` GUC set per transaction),
CI isolation-matrix expansion across module APIs, Redis-backed rate limits on
`/api/auth/**` + invitation + sensitive endpoints, security headers CSP, forced
sign-out (bump `sessionVersion`) surfaced in the UI.

- **Shipped in the operator's "Phase 14" security-hardening pass** (ADR-0029,
  `docs/SECURITY-AUDIT.md`): a CSP header; a first fail-open Redis rate-limit
  layer on magic-link send / OAuth connect+callback / agent stream / health /
  crawl start; OAuth callbacks bound to the session that started the flow.
- **Still to do:** Postgres RLS; the full edge/IP rate-limit layer + an
  aggregate magic-link volume cap; a strict nonce-based `script-src`;
  invitation email; forced-sign-out UI.

### Security-hardening pass ✅ (operator's "Phase 14")

A whole-application security audit (no features added).
`docs/SECURITY-AUDIT.md` — 0 Critical, 2 High, 3 Medium, 3 Low, 6
Informational; **every Critical/High fixed**. New
`packages/services/src/security/` (`rate-limit.ts` — fail-open Redis
fixed-window limiter; `untrusted.ts` — `wrapUntrusted` +
`UNTRUSTED_CONTENT_SYSTEM_CLAUSE` prompt-injection fence). Session-bound OAuth
callbacks, a CSP, `timingSafeEqual` on `/api/metrics`, provider errors no longer
carry token-bearing bodies + broader pino redaction, explicit numeric-hostname
rejection in `seo/ssrf.ts`. See ADR-0029.

### Full QA pass ✅ (operator's "Phase 15")

Production-level QA. No product code changed. `docs/QA.md` is the coverage map
(every area × layer × local/CI). Added three CI-Postgres integration suites
(tenant isolation; automation-tick idempotency under concurrency; Stripe
webhook dedupe under concurrency — all self-skip locally) and three Playwright
specs (`e2e/api.spec.ts` HTTP-contract, `e2e/ui.spec.ts` auth-form + mobile,
`e2e/authed.spec.ts` authenticated browser flows via a minted NextAuth cookie,
gated by `E2E_AUTHED=1` + Postgres). Password recovery is N/A (no passwords);
Notifications is N/A (model unimplemented). See ADR-0030.

### Production deployment prep ✅ (operator's "Phase 16" — not deployed)

Deployment _preparation_ only. `Dockerfile.web` (Next.js standalone),
`Dockerfile.worker` (Node + Playwright Chromium, runs from TS via `tsx`),
`.dockerignore`, `docker-compose.production.yml` (web + worker + Caddy auto-TLS

- one-shot `migrate`, external managed Postgres/Redis/S3), `deploy/`
  (`Caddyfile`, `prometheus.yml`, `alerts.yml`, `backup/pg-backup.sh` +
  `pg-restore.sh`). `scripts/check-env.mjs` — zero-dep env validator that never
  prints secret values (`pnpm check:env` / `pnpm test:scripts`). `next.config.mjs`
  gains `outputFileTracingRoot` + Prisma-engine tracing. 17-step runbook in
  `docs/DEPLOYMENT.md`. See ADR-0031. **Still to do (roadmap "Phase 12"):** a
  real deploy, egress-isolated crawl pool, full CSP nonce, DAST/pen test, load
  tests, RLS, DSR flows, backup-restore drill.

### Final production-readiness audit ✅ (operator's "Phase 17")

Independent CTO-style launch review. `docs/PRODUCTION-READINESS.md` — **0
BLOCKER, 0 CRITICAL**, 2 HIGH, 5 MEDIUM, 6 LOW — with the 8 required
deliverables. Full pipeline green (format/lint/typecheck, 515+9 tests, normal
web build, worker typecheck, `prisma validate`, 0-drop additive migrations).
Fixed H-1 (public `/r/[token]/export` PDF-render DoS → rate-limited + cacheable)
and M-1 (admin `loading.tsx`). H-2 (`nodemailer` CVEs — peer-locked to v8 by
`next-auth` beta) documented + on the launch checklist. No verdict of
"production-ready" without the checklist items in §8 (Docker/standalone build on
a real builder, migration-drift check, mail-domain auth, OAuth/TikTok approvals,
monitoring wiring). See ADR-0032.

### Complete application audit ✅ (operator's "Phase 18")

Independent full-application audit (CTO / QA / security / DevOps / product),
audit-only — no features, no redesign, no unnecessary refactor.
`docs/FINAL-AUDIT.md` — **0 BLOCKER, 0 CRITICAL**, 3 HIGH (SEC-1 `nodemailer`
CVEs peer-locked to v8; FEAT-1 magic-link sign-in non-functional without an SMTP
provider; COMP-1 no account/org deletion or DSR flow), ~11 MEDIUM, ~9 LOW, plus
the 13-section report and the 10-item final CTO report. Full pipeline green
(format, lint 14/14, typecheck 14/14, unit 515/515, env script 9/9, integration
in CI, Playwright e2e 58 passed / 5 infra-skipped, web + worker builds exit 0,
`prisma validate`, 0-drop migrations). No code changed beyond doc corrections:
object storage / Sentry / Google Search Console / notifications are referenced in
env/enum/docs but **not implemented** — docs softened to "planned". **Verdict:
NOT production-ready for GA; defensible for a closed / invite-only beta** once
email sign-in and the container build work. GA critical path: verify the
Docker + Next standalone build on a real builder, deploy monitoring/alerting,
resolve or formally accept SEC-1, implement COMP-1 for EU/CA, commission a
penetration test. See ADR-0033.

### Forensic codebase audit ✅ (operator's "Phase 18 — Forensic")

Evidence-only re-inspection (source, schema, migrations, routes, worker, tests,
CI, deploy files), not trusting prior claims. `docs/FORENSIC-AUDIT.md` — 10
sections with severity BLOCKER/CRITICAL/HIGH/MEDIUM/LOW. **Deploy blockers:**
container images never built (CI only lints Dockerfiles, `continue-on-error`) and
the standalone build path is never exercised; magic-link sign-in inert without
`EMAIL_TRANSPORT=smtp`; no boot-time env validation (`apps/web/src/env.ts` is
dead code); monitoring configured but not deployed. **MISSING (documented,
zero code):** object storage, Sentry, OpenTelemetry, Resend/Upstash,
notifications, Google Search Console. **HIGH:** no account/org deletion or DSR
flow; Postgres RLS documented but unimplemented; `nodemailer` advisories not
gated in CI. No BROKEN runtime code; no source changed. See ADR-0034.

### Google Search Console integration ✅ (operator's "Phase 20")

Real integration against Google's Search Console API v1 (`webmasters/v3` + URL
Inspection). Reuses the Google OAuth client + the `/api/integrations/google/callback`
route (provider-aware via the signed `state`); scopes `webmasters.readonly` +
`openid` + `userinfo.email`, AES-256-GCM tokens, refresh + health + disconnect.
Property discovery / selection / verification status (`SearchConsoleSite`);
`SearchConsoleSnapshot` captures of search performance (queries / pages /
countries / devices / search appearance), sitemaps (submitted vs indexed), and
per-URL indexing (URL Inspection — on-demand, quota-scarce; **no bulk coverage
export exists**). Dashboard at `/app/seo/search-console`. The AI SEO Agent
combines crawler + Search Console evidence with three deterministic,
source-labelled correlations (`crawlerEvidence` / `searchConsoleEvidence` /
`interpretation`) — issue on an impression page, impressions but low CTR,
sitemap page with weak internal linking — and never invents a GSC metric. New
migration `20260918120000_search_console` (2 models, additive). Resolves
FORENSIC-AUDIT M-5 / INT-3. `docs/GOOGLE-SEARCH-CONSOLE.md`; ADR-0036.

### Production AI configuration ✅ (operator's "Phase 22")

Audit + productionization of the AI layer (no new features). `packages/ai`:
`withResilience` (per-call `AI_REQUEST_TIMEOUT_MS` deadline + one timeout retry +
`AI_DISABLED` / `AI_DISABLED_PROVIDERS` kill switch), `FallbackProvider`
(`AI_FALLBACK_MODELS` cross-provider chain), `modelForRole` (`AI_MODEL_<ROLE>`
env → `router` / `analyst` / `long_context` / `embedding`). `createRegistryFromEnv`
wraps every provider so all call sites gain it unchanged; transient 429/5xx retry
stays in the SDK (`AI_MAX_RETRIES`). New `usage.enforceAiUserLimit` — fail-open
Redis per-user AI throttle in front of the per-org `AI_REQUESTS` cap.
Prompt-injection fencing (`wrapUntrusted` + standing clause) extended to **every**
model prompt (YouTube / TikTok / monetization analysts, content generator, Growth
Agent planner + orchestrator + memory). New adversarial suites
(`agents/adversarial.test.ts`, `packages/ai/*.test.ts`, `usage/ai-limit.test.ts`).
Structured output, restricted tools and confirmation-before-action were verified,
not changed. `docs/AI-PRODUCTION-AUDIT.md`; ADR-0037.

### Production billing ✅ (operator's "Phase 23")

Audit + gap-close of the subscription + metering system (no schema change, no
dependency). Verified unchanged: the 5-tier `PLAN_CATALOG`, the
signature-verified doubly-idempotent + retry-safe Stripe webhook, server-side
`billing:manage` on every Server Action, Stripe-hosted URLs only across the
wire. Gaps closed: `usage.enforceAiBudget` enforces **both** `AI_REQUESTS` and
`AI_TOKENS` before every model turn (agent stream + the four analyst actions);
`AI_TOKENS` + a new `CRAWL_PAGES` pre-flight gate are exhaustion gates
(unknowable up front, ADR-0038); `invoice.payment_failed` / `PAST_DUE` now write
a `WARNING` `Notification` (recovery → `INFO`) via the existing
`createNotification`. New tests: `billing/lifecycle.test.ts` (full
signup→…→deletion), `billing/expiration.test.ts`, `usage/enforcement.test.ts`
(over-limit for all 7 metered resources), `usage/ai-budget.test.ts`, extended
`billing/webhook.test.ts` + `billing/plans.test.ts`.
`docs/BILLING-PRODUCTION-AUDIT.md`, `docs/BILLING.md`; ADR-0038.

### SEO crawler security audit ✅ (operator's "Phase 24")

An adversarial audit — findings reproduced live against the running code, then
fixed. **BLOCKER:** `seo/ssrf.ts` failed to recognize IPv4-mapped/6to4/NAT64
IPv6 literals in their canonical hex-group form (what a real parsed URL
produces), letting `http://[::ffff:169.254.169.254]/`-style targets reach cloud
metadata; fixed by decoding the embedded v4 from numeric groups. **CRITICAL:**
robots.txt/crawl-scope wildcard matching used a backtracking regex — a ~40-char
attacker-controlled robots.txt pattern hung the shared worker process
indefinitely; fixed with a new linear (no-backtracking) matcher
(`seo/pattern-match.ts`). **CRITICAL:** the headless-render path validated
subresource URLs but let Chromium connect with its own unpinned DNS resolution
(a DNS-rebinding TOCTOU); fixed with a new local pinning CONNECT/HTTP proxy
(`seo/pinning-proxy.ts`) every render's browser context now routes through.
**HIGH (fixed):** duplicate-content clustering was O(n²) in the common case;
bucketed by simhash prefix. **HIGH (documented):** the 200k-page crawl ceiling
is independent of the plan's `CRAWL_PAGES` budget. Everything else in the
brief (localhost/private/link-local/metadata/internal-hostname targets, huge
pages/headers, decompression bombs, large sitemaps, slow responses, connection
exhaustion) was already correctly defended, confirmed by direct testing.
`docs/CRAWLER-SECURITY-AUDIT.md`; ADR-0039.

### AI red team ✅ (operator's "Phase 25")

Attacked the AI layer as a malicious user — instruction hijacking / system-
prompt extraction, secret exposure, unauthorized external actions,
cross-tenant access, tool manipulation, indirect injection via crawled/social
content — reproducing each attack as a test against the real code before
deciding what to fix. Most named attacks were already closed structurally
(no model-driven tool-calling loop, org scoping from server context never
from the message or model output, no write/publish tool anywhere in the
agent layer) and are now pinned by `packages/services/src/agents/ai-red-team.test.ts`
rather than new code. Three gaps fixed: the shared
`UNTRUSTED_CONTENT_SYSTEM_CLAUSE` (already on every model-facing prompt) now
states the SYSTEM/DEVELOPER > USER > EXTERNAL DATA trust hierarchy by name
and forbids system-prompt disclosure / authority-elevation claims; a new
`agents/output-scrub.ts` (`scrubModelOutput`) deep-scrubs every agent's final
output for secret-shaped strings before persistence/return, on both the
model path and the deterministic fallback; and `agent/orchestrator.ts`'s new
`finalizeBlocks` forces `requiresConfirmation: true` on every external
proposed action unconditionally, closing the one field the grounding check
never examined. `docs/AI-SECURITY-AUDIT.md`; ADR-0040.

### Data accuracy validation ✅ (operator's "Phase 26")

Traced every displayed metric (Source → API field → DB field → Calculation
→ Display) across YouTube, TikTok, Search Console, the SEO crawler, revenue
tracking, and the reporting engine's growth-percentage math, hand-verifying
calculated values rather than trusting a read of the code. Every
derived-metrics function was already a correct pure computation; eight
defects were found at the missing/zero/estimated boundary. Fixed: YouTube's
`syncAnalytics` now throws on an Analytics response missing a requested
metric column instead of zero-filling it; TikTok video sync skips (rather
than fabricating a 1970-01-01 date for) a video missing `create_time`; a
dead "Net subs (28d)" stat on the YouTube Performance page is wired to its
real value; Search Console's own aggregate CTR/position are `null` (not `0`)
on zero impressions, since Google never reports a real position of `0`; the
Revenue tracker's copy no longer claims "nothing is estimated" beside a
genuinely estimated figure. **A hand-verified test caught a live bug**: the
first exact-value test for the recurring-revenue estimate failed against the
real code, exposing a timezone bug (local-time date getters on UTC-parsed
instants) that silently corrupted the estimate on any non-UTC server — fixed
to use UTC getters. New `tiktok/metrics.test.ts` (previously zero coverage),
plus hand-computed exact cases added across five existing test files.
`docs/DATA-ACCURACY.md`; ADR-0041.

### Full E2E testing ✅ (operator's "Phase 27")

A complete Playwright journey (signup → onboarding → dashboard → connect
YouTube/TikTok/Search Console → add website → crawl → issues → AI agent →
content → recommendation → task → report → billing → change plan → logout)
plus failure-injection and security tests, on top of Phase 15's existing
suite. Running the existing e2e suite exactly as CI configures it — before
writing anything new — found a real bug: `GET /api/health` returned 500
under that boot configuration (`config/env.ts`'s prod-strict validation
throwing at module-import time, poisoning the first route that touches
`@growth-agent/services`), breaking Phase 13's "always 200" contract. Fixed
by wiring the existing `GROWTH_AGENT_ENV_STRICT=0` escape hatch into the e2e
boot and making `/api/health`'s own imports load dynamically so a config
failure degrades gracefully instead of 500ing. New `e2e/{journey,failures,
security}.spec.ts` + a shared `support/seed.ts`; real OAuth/Stripe consent
screens are never automated — connected/paid states are seeded directly, the
"Connect" buttons are verified to reach the real provider's authorize host.
**Verification limit:** this machine's Docker Desktop can't start
(virtualization disabled in firmware) — confirmed instead: full pipeline
green, and a DB-less e2e run passing all 61 runnable tests with the 27
DB-gated ones (four existing + 23 new) skipping cleanly rather than
erroring. `docs/E2E-TESTING.md`; ADR-0042.

### Performance and load testing ✅ (operator's "Phase 28")

Measured frontend/API/DB/Redis/AI/crawler/background-job performance and
optimized what a redundant-work audit found, without a live Postgres/Redis
(same firmware block as Phase 27). Combined real `autocannon` load tests
against every database-free endpoint, one bug reproduced live, and an
architectural capacity analysis for the rest, every number labeled measured
or projected. **Found and fixed live:** `GET /api/health` stalled ~4s with
the DB unreachable because three of its five checks had no explicit
timeout — `Promise.all` doesn't protect against the Prisma driver
serializing its own connection attempts underneath it — fixed with the same
bounded `Promise.race` pattern `pingRedis` already used, confirmed live at
~2.7s bounded vs. the prior recurring ~4s stall. Also fixed: the Growth
Agent orchestrator's and content generator's serial per-item AI-call loops
now run concurrently with error isolation preserved; a duplicate
Subscription query removed by widening `resolveEntitlements`'s existing
read; the crawler `finalize()`'s two N+1 write loops extracted into
exported, bounded-concurrency functions with new fast unit tests (this code
had zero before); three oversized `select`/`include`s narrowed;
`requireUser`/`requireActiveOrg` memoized per-request via React's `cache()`;
a `Recommendation` index gap closed with a hand-authored migration.
Documented, not fixed: BullMQ per-queue concurrency, a caching layer,
speculative extra indexes, and horizontal scaling — none justified without
live telemetry this environment can't produce. `docs/PERFORMANCE-REPORT.md`;
ADR-0043.

### UI/UX accessibility audit ✅ (operator's "Phase 29")

Audited desktop/tablet/mobile navigation, forms, tables, dialogs, loading/
empty/error states, keyboard/ARIA/contrast/reduced-motion, and resilience
under missing data/API failure/thousands of records/slow AI/an in-progress
crawl — no redesign, fix what's necessary. Three research passes plus
hand-computed WCAG contrast ratios found a bounded set of real gaps, not a
systemic problem. Fixed: a `prefers-reduced-motion` guard (previously zero
occurrences repo-wide); light-mode `--muted-foreground` darkened off the
WCAG AA edge; `CardTitle` changed from `<div>` to `<h3>` app-wide (153 call
sites, zero visual change since `className` drives all styling) with
`Badge` moved to `<span>` for valid heading nesting; `Skeleton` made
`aria-hidden` with one `role="status"` per loading view instead of one per
bone; every transient form/action result across the app (previously zero
ARIA linkage anywhere in `apps/web`) now announces to screen readers,
scoped deliberately to just-performed actions and not static persisted
data; the crawl issues list's hard 100-item cap replaced with cursor
pagination matching the existing YouTube/TikTok pattern, plus an exact
total count; table headers gained `scope="col"`; smaller fixes to an
unlabeled select, empty-state consistency, and two missing `loading.tsx`
files. Documented, not fixed: a toast system, new component primitives,
live crawl-status polling, an agent-chat cancel/timeout — each a new
feature or unverifiable without live infrastructure this environment
lacks. `docs/ACCESSIBILITY-AUDIT.md`; ADR-0044.

### Staging deployment ⚠️ (operator's "Phase 30", runbook only)

This session has no cloud account, domain, or Google/TikTok/Stripe/
email-provider credentials — no cloud CLI installed, none in the
environment — so nothing could be deployed for real; the user chose a
runbook-only path over handing over live infrastructure access. Delivered
`docs/STAGING.md`, a complete staging-flavored walkthrough of
`docs/DEPLOYMENT.md`'s production process: domain/DNS, Supabase Postgres,
Upstash Redis, an optional AI provider key, one Google OAuth client
serving YouTube + Search Console + sign-in, a sandbox TikTok app, **Stripe
TEST mode only** with a mechanical live-key grep check, email via Resend or
console, migrations, starting web/worker, and a concrete verification
checklist (health, background jobs, OAuth callbacks, webhooks, the
crawler, AI, billing). New `docker-compose.staging.yml` (a deliberate,
separate near-duplicate of the production compose file, since Compose's
`env_file:` path is a literal string and reusing the production file would
need a confusingly-named `.env.production` full of staging secrets) and
`.env.staging.example` (validated by filling it with placeholder values and
running `check-env.mjs` against it — passed, confirming every variable name
matches the real validator). Object storage is explicitly documented as not
an app feature (no code reads `S3_*`) rather than configured as if it were.
Staging deliberately still runs `NODE_ENV=production` and full strict env
validation — no relaxation escape hatches — since the point is rehearsing
production's real boot behavior. **No staging environment is actually
operational as a result of this phase.** `docs/STAGING.md`; ADR-0045.

### Final security review ✅ (operator's "Phase 31") — Verdict: GO

A consolidation + fresh-eyes pass over five prior security audits (Phases
14, 18, 24, 25, plus billing/AI production audits), re-verifying every
claim against current code and hunting for regressions from the five
non-security phases since (26-30) — none found. Ran or attempted every
requested tool: `pnpm audit --prod` clean; the full scan (incl.
devDependencies) surfaced 1 critical + 1 high + 5 moderate, all in
vitest/vite/esbuild test tooling with zero production exposure, needing
`vitest --ui` (never invoked anywhere in this repo) — documented, a major
toolchain bump deferred to its own phase. `detect-secrets`/Semgrep/Trivy
couldn't run in this Windows/no-Docker sandbox (disclosed); substituted a
targeted git-grep secret scan (clean), manual code review, and a live
DAST-style pass confirming every security header/CORS/CSP claim against
the actual running app. Crawler-SSRF (75), AI red-team (34), and
`security` (11) suites re-run clean, matching Phases 24/25 exactly.
**Found and fixed two real HIGH bugs no prior audit caught**: backups
could ship unencrypted (`deploy/backup/pg-backup.sh` now requires
`BACKUP_GPG_RECIPIENT`); `regenerateAssetAction` made real AI calls with
zero metering — no throttle, no quota check, no usage record — fixed by
matching its sibling action's existing three-call pattern. Five MEDIUM
fixes: broken MinIO backup pruning, `REDIS_URL` not TLS-enforced in
production, a new Disaster Recovery section naming the single-host SPOF as
an accepted risk with an honest RTO/RPO, a corrected object-storage
section (previously described a feature that doesn't exist), and a new
webhook-signature-failure metric + alert verified live end-to-end.
`docs/FINAL-SECURITY-REPORT.md`; ADR-0046.

### Production gap remediation ✅ (operator's "Phase 19")

Fixed every BLOCKER / CRITICAL / HIGH from `docs/FORENSIC-AUDIT.md`
(`docs/REMEDIATION-REPORT.md`, ADR-0035): a real CI Docker build + compose
health smoke + standalone build (D-1); a real Resend HTTP transport for the
magic link + a "no sign-in path" boot/CI guard (D-2); boot-time env validation
in `packages/services/src/config/env.ts` imported by the web root + worker, dead
`apps/web/src/env.ts` deleted (D-3); a real `Notification` model + service wired
to report/crawl/automation/invite events with a bell + `/app/notifications` and
best-effort email (M-1); org + user account deletion (soft-delete → grace →
hourly worker purge, cascades; `crawl_pages`/`crawl_links` FKs → CASCADE) + a
JSON DSR export (M-2 / D-8); `/api/client-error` + edge capture + Prometheus/
Alertmanager in the prod compose (D-4); a CI security-audit gate with an
allowlist (D-5 / S-2). **Postgres RLS (M-9 / S-1) is deferred to its own
phase** — the assumed `withOrgScope` choke point is unused (~321 direct calls);
`scripts/check-tenant-scope.mjs` gates CI as the interim backstop. Docs
corrected: S3 / Sentry / OTEL / Upstash / GSC marked NOT IMPLEMENTED. All gates
green (integration / e2e / Docker in CI).

### Phase 4 — Billing & usage ✅ (operator's "Phase 10")

`packages/services/src/billing` + `packages/services/src/usage`.

- **Config plan catalog** (`billing/plans.ts`) — the single source of truth for
  FREE / CREATOR / PRO / AGENCY / ENTERPRISE: display price, per-meter limits
  (`null` ⇒ unlimited), feature flags. Prices are never hard-coded per call
  site; Stripe Price IDs are env config. The marketing pricing page + the
  in-app plan grid both render from `listPlans()` (ADR-0025).
- **`BillingGateway`** — a hand-rolled Stripe adapter (REST via `fetch`,
  webhook HMAC via `node:crypto`, no SDK / no new dependency); `NullBillingGateway`
  when Stripe is unconfigured (app runs FREE-for-all, limits still enforced).
- **Flows** — `startCheckout`, `openBillingPortal`, `changePlan` (upgrade with
  prorations / downgrade at period end / needs-checkout when FREE),
  `cancelSubscription` (at period end), `resumeSubscription`, and
  `getBillingSummary` (plan · status · usage snapshot · invoices).
- **Webhooks** (`/api/billing/webhook`) — signature-verified, **idempotent**:
  a `BillingEvent` ledger keyed on the Stripe event id + stripe-id-keyed
  upserts. Handles `checkout.session.completed`, `customer.subscription.*`,
  `invoice.*`. Bad signature → 400; unknown type → recorded SKIPPED.
- **Entitlements** — `syncPlanEntitlements` materialises PLAN rows from the
  catalog on every tier change; `resolveEntitlements` overlays OVERRIDE / PROMO.
- **`usage` module** — `checkUsage` (verdict, no mutation) → do work →
  `recordUsage` (idempotent on `idempotencyKey`, counter incremented in the
  same tx as the ledger insert); `enforceUsage` throws `usage_limit_exceeded`
  (429) **server-side**; `refreshUsageCounters` self-heals from the ledger;
  gauges (seats, connected accounts) read a live count. Meters: `AI_REQUESTS`,
  `AI_TOKENS`, `CRAWLS`, `CRAWL_PAGES`, `CONNECTED_ACCOUNTS`, `REPORTS`,
  `CONTENT_GENERATIONS`, `SEATS`.
- **Enforcement wired** at the SEO crawl action, the content-generation action,
  the agent-stream route + growth-agent job (AI meters), and the OAuth connect
  routes — same one-line pattern extends to the other agents and to reports.
- Migration `20260913120000_billing` (additive: `Subscription`, `Entitlement`,
  `UsageRecord`, `UsageCounter`, `Invoice`, `BillingEvent`). `/app/billing` UI.
  See `docs/BILLING.md`.
- **Deferred:** RLS + a tier-enforcement edge middleware layer (Phase 3); the
  nightly reconcile + counter rollup run inline (no worker queue); Stripe
  usage-record push for metered overage; `REPORTS` enforcement waits for the
  reports feature; the `STARTER` tier shipped as `CREATOR`.

### Phase 5 — Integrations framework — partly ✅ (YouTube slice)

Shipped with the YouTube agent: `OAuthConnection` + AES-256-GCM token envelope
(`crypto/tokens.ts`), signed OAuth `state`, Google connect / callback /
disconnect, `withFreshAccessToken` proactive refresh + 401 retry,
`IntegrationHealth` + per-connection quota accounting, Integrations UI.
**Still to do:** Google Search Console + TikTok providers, a background
token-refresh poll job, provider health in `/admin`, and the SSRF-safe fetch
layer for the crawler + AI tools.

### Phase 6 — SEO engine ✅ (operator's "Phase 5")

Shipped in `packages/services/src/seo`: URL normalization + scope; the
authoritative **SSRF/DNS-rebinding guard** (`ssrf.ts` — resolve-then-pin,
reject-mixed-DNS, IP-range table, scheme/port allowlist, every redirect hop
re-validated); the safe fetch client (`fetch.ts` — byte cap, bounded
decompression, credential stripping, injectable transport); robots.txt parser +
matcher (longest-match, `$`, `Crawl-delay`); bounded sitemap parser (entity
expansion **off**, protocol limits); cheerio HTML extraction (title/meta/
canonical/headings/links/images/JSON-LD/OG/Twitter/hreflang/viewport + a
CSR-likely signal); simhash/contentHash fingerprints; the in-memory frontier
(ADR-0018); per-host rate limiter + concurrency limiter + retry/backoff; the
render decision + `PageRenderer` seam (Playwright adapter in `apps/worker`, with
an SSRF-safe subresource interceptor); page evaluation (indexability /
crawlability / security headers / mixed content); the link-graph analysis
(BFS depth, orphans, broken links, redirect chains/loops, duplicate clusters,
canonical conflicts, parameter explosion); the technical auditor rule catalogue
(`rules.ts`, ~38 rules across 9 categories); category scoring with a
**published weighting** (`scoring.ts`); the crawl orchestrator (`crawler.ts`)
with max pages/depth/time, pause/resume/cancel, a kill switch; ownership
verification (DNS TXT / HTML file); the grounded **SEO Auditor Agent**
(`audit-summary.ts`, reusing the shared grounding check). Prisma migration
`20260908120000_seo_crawler` (`Website`, `Crawl`, `CrawlPage`, `CrawlLink`,
`CrawlIssue`). `/app/seo` UI (websites, verification, crawl config + controls,
score cards, issue list, architecture, AI summary). `seo-crawl` worker queue.
**Deferred:** object storage for raw HTML, `CRAWL_PAGES` metering, a dedicated
network-isolated egress pool, `FILE_UPLOAD`-style rendered-HTML archiving, and a
distributed (Redis) frontier for very large crawls.

### Phase 7 — AI orchestration & agents — mostly ✅ (analysts + SEO Agent + Growth Agent)

**Shipped:** the grounded analyst pattern (`agents/grounding.ts` +
`youtube-analyst`, `tiktok-analyst`, `seo-auditor`); the **AI SEO Agent**
(operator's "Phase 6"): `seo/agent-tools.ts` (nine read-only `seo.get_*` tools,
no write path — ADR-0021), `seo/recommendation-engine.ts`,
`seo/ai-readability.ts`, `seo/agent.ts`, migration `20260909120000_seo_agent`;
and the **Unified AI Growth Agent** (operator's "Phase 7"):
`packages/services/src/agent` — capability registry (`org-context`,
`youtube-analyst`, `youtube-monetization`, `tiktok-analyst`, `seo-agent`,
`content-repurpose`, `growth-plan`), deterministic keyword planner (model-refined),
grounded synthesis into `GrowthAgentResponse` with a deterministic fallback,
SSE streaming (`/api/agent/stream`), conversation store (list / rename / delete /
search / export), controlled `OrgMemory` (six kinds, redacted), `Task`s from
recommendations, and the `/app/agent` + `/app/tasks` UI. Migration
`20260910120000_growth_agent` (`AIConversation`, `AIMessage`, `OrgMemory`,
`Task`). `agent-run` worker queue live (ADR-0022).
**Still to do:** the general model-driven orchestrator (route → plan DAG →
execute with step/token/time budgets), `generateWithTools` in `packages/ai` +
`AgentToolCall` rows, `pgvector` semantic memory, the remaining agents
(`growth-analyst`, `content-strategy`, `monetization-opportunity`,
`recommendation`, `reporting`), org automation mode + agent kill switches, and
the eval harness + golden sets.

### Phase 8 — YouTube analytics ✅

Data API v3 + Analytics API v2 clients with quota budgeting, backoff, and typed
failure modes; incremental channel / video / analytics sync (`YouTubeChannel`/
`YouTubeVideo`/`YouTubeMetric`/`YouTubeSyncRun`); the **YouTube Analyst Agent**
with a fact-sheet + grounding check (ADR-0014); `AgentRun`/`Recommendation`/
`ContentIdea` tables; the `/app/youtube/*` dashboard (Overview, Performance,
Videos, Growth, Content opportunities, Monetization, Recommendations); the
4-section **Monetization** page with a labelled readiness prediction and
explicit "unavailable + how to verify" markers. See
`docs/YOUTUBE-INTEGRATION.md`.

**Follow-ups:** per-video analytics (retention, traffic sources, impressions/
CTR); switch sync to queue-by-default (ADR-0013); wire a
`monetization-opportunity` agent distinct from the analyst.

### Phase 9 — TikTok growth agent ✅

Login Kit OAuth (client_key + **PKCE**, ADR-0015), provider-OAuth registry
(ADR-0016), Display API client with typed failure modes, incremental account +
video sync (`TikTokAccount`/`TikTokVideo`/`TikTokMetric`/`TikTokSyncRun`), the
**TikTok Analyst Agent** (fact sheet + shared grounding check, `TIKTOK`
recommendations + content ideas), the `/app/tiktok/*` dashboard (Account
overview, Video library, Performance, Content opportunities, Recommendations,
Publishing), and **authorized publishing** via the Content Posting API
(`PULL_FROM_URL`, explicit approval, duplicate-publish guard, status polling,
full audit trail — ADR-0017). API limitations documented in
`docs/TIKTOK-INTEGRATION.md`.

**Follow-ups:** `FILE_UPLOAD` publishing source; queue-by-default publishing
status polling; TikTok connection health in `/admin`.

### Content repurposing engine ✅ (operator's "Phase 8")

`packages/services/src/content` — the pipeline SOURCE → CONTENT ANALYSIS →
KEY IDEAS → CONTENT ANGLES → PLATFORM-SPECIFIC CONTENT → APPROVAL →
PUBLISH/SCHEDULE. `ingest.ts` (source from a synced YouTube video / URL+text /
transcript / manual — never scrapes or transcribes, ADR-0023); `analyze.ts`
(one grounded `generateObject` → `ContentAnalysis`; light grounding + a
deterministic fallback); `generate.ts` (13 deliverable types — title
alternatives, descriptions, chapters, Shorts/TikTok ideas, TikTok captions,
hooks, scripts, social posts, blog ideas, SEO outlines, FAQs, newsletter ideas
— each → a `ContentAsset` + `ContentAssetVersion` v1, status DRAFT);
`assets.ts` (edit → new version + reset to DRAFT; approve; schedule; **mark
published** — a status marker, the engine never publishes; mark failed; revert;
regenerate; every transition audit-logged). Migration
`20260911120000_content_repurposing` (`RepurposeProject`, `ContentAsset`,
`ContentAssetVersion`). `/app/content` UI + `content-pipeline` worker queue +
new RBAC action `content:manage`. See `docs/CONTENT-REPURPOSING.md`.
**Deferred:** object-storage for large source bodies, a real scheduler for the
due-content sweep, direct hand-off to the TikTok publish-approval flow.

### Monetization intelligence engine ✅ (operator's "Phase 9")

`packages/services/src/monetization` — `signals.ts` (deterministic snapshot of
connected YouTube/TikTok/SEO data + the user-provided `BusinessProfile` + a
read-only revenue summary); `engine.ts` (`buildOpportunities` — one
`OpportunityDraft` per applicable channel across 11 channels, each with the
seven required fields — Opportunity, Evidence, Audience fit, Estimated
difficulty, Estimated potential, Required action, Confidence — plus a
`priorityScore`; estimates are labels `Low`/`Moderate`/`High`, never dollar
amounts; PLATFORM_MONETIZATION readiness derives entirely from the conservative
`assessMonetization` and defers eligibility to the platform, ADR-0024);
`analyst.ts` (`runMonetizationScan` — optional grounded model prose pass,
dropped on any grounding failure; persisted as `AgentRun`
`monetization-analyst`; dedupes on `(org, channel)` keeping a user-advanced
status); `opportunities.ts` (status lifecycle + promote-to-`Task`);
`revenue.ts` (**user-entered only** — `createdById` required, soft delete,
`getRevenueSummary` with a `YYYY-MM` monthly history); `read.ts`
(`getMonetizationDashboard` — current / potential / recommended actions /
completed / revenue). Migration `20260912120000_monetization` (additive:
`BusinessProfile`, `MonetizationOpportunity`, `RevenueEntry`). `/app/monetization`
UI + new RBAC action `monetization:manage` (MEMBER+). See `docs/MONETIZATION.md`.
**Deferred:** a scheduled re-scan worker queue (`runMonetizationScanJob` is
wired but runs inline for now); pulling revenue from platform APIs (out of
scope — revenue is user-provided).

### Reporting engine ✅ (operator's "Phase 11")

`packages/services/src/reports` — a professional report for each of seven types
(YouTube, TikTok, SEO, Website Health, AI Recommendations, Growth,
Monetization), each with the same seven sections: Executive Summary · Key
Metrics · Problems · Opportunities · Recommendations · Priority Actions ·
Historical Changes.

- **Immutable snapshots** (ADR-0026). `generateReport` gathers deterministic
  facts from the module read functions, assembles the sections, builds the
  executive summary (deterministic, or a grounded model pass dropped on any
  grounding failure), and writes the full `ReportSnapshot` (`packages/core`
  `schemas/report.ts`) once when the report is `READY`. It is never mutated;
  regenerating creates a new row linked to the previous one via
  `previousReportId`, which drives the Historical Changes diff.
- **Exports rendered on demand** from the snapshot — dashboard view,
  `renderExport` → PDF (a hand-rolled ~200-line writer, base-14 Helvetica, no
  dependency), CSV (pure), JSON. No object storage, no stale files.
- **Share links**: `/r/<token>` serves `redactSnapshotForPublic(snapshot)` only
  — generic subject/org labels, free text scrubbed of emails / URLs / handles /
  ids, monetary amounts hidden. Unknown / expired / revoked token → 404. New
  `report:share` action (ADMIN+) creates/revokes links; `report:generate`
  (MEMBER+) generates/deletes; `report:read` (VIEWER+) views + authenticated
  export.
- `usage.enforceUsage({ meter: 'REPORTS' })` runs before generation
  (Phase 10's wiring point); the `report-generation` worker queue now has a
  real processor (single reports still generate inline, ADR-0013).
- Migration `20260914120000_reporting` (additive: `Report`). `/app/reports`
  list + `/app/reports/[id]` detail + `/r/[token]` public view. See
  `docs/REPORTING.md`.
- **Deferred:** charts in the PDF, scheduled report packs, richer per-report
  params in the UI.

### Automation engine ✅ (operator's "Phase 12")

`packages/services/src/automation` + the `automation` BullMQ queue.

- **`AutomationRule`** rows carry the schedule (`cadence` DAILY/WEEKLY/MONTHLY →
  a derived 5-field cron, or a raw CUSTOM expression) plus `status`,
  `nextRunAt`, `failureCount`, `totalRuns`, `maxRetries`, `ownerId`. Seven task
  types: `YOUTUBE_ANALYSIS`, `TIKTOK_ANALYSIS`, `WEBSITE_CRAWL`,
  `SEO_ISSUE_ALERT`, `MONETIZATION_SCAN`, `GROWTH_REPORT`,
  `CONTENT_OPPORTUNITY`.
- **`cron.ts`** — a ~150-line hand-rolled 5-field parser + "next run" evaluator
  (UTC), no dependency (ADR-0027).
- **Worker sweep** — a repeatable job every 60s finds due rules, claims one
  idempotent `AutomationRun` per tick (`@@unique([ruleId, scheduledFor])`), and
  executes it inline; a retry-sweep every 30s re-runs backoff retries.
- **Owner-permission re-check at run time** — the runner resolves the owner's
  current role and `authorize()`s the task's `requiredAction`; a lost role → the
  run is `SKIPPED` and the rule `PAUSED`. **No task type publishes externally**
  (`assertNoExternalPublish()` invariant).
- **Retry / backoff / escalation** — failed runs retry with exponential backoff
  (cap 1h) up to `maxRetries`; 5 consecutive failures → `FAILING`, 10 →
  `DISABLED`. Every run is logged (`AutomationRun`) and audited.
- New RBAC action `automation:manage` (MEMBER+). Migration
  `20260915120000_automation` (additive: `AutomationRule`, `AutomationRun`).
  `/app/automations` list + `/app/automations/[id]` detail (execution log). See
  `docs/AUTOMATION.md`.
- **Deferred:** timezone-aware schedules (UTC-only for now), a notification
  channel (an alert automation opens a `Task`), per-run hand-off to a dedicated
  execute queue.

### Phase 10 — Recommendations, tasks, notifications ⬜

`Recommendation` lifecycle UI (approve/reject/apply/promote), `Task` board,
`Notification` delivery (in-app + Resend email) + preferences + digests,
dashboard aggregation. (`Report` generation shipped as the operator's "Phase 11"
— see above.)

### Phase 11 — Admin console ✅ (operator's "Phase 13")

`packages/services/src/observability` + the `apps/web/app/(admin)/admin/*` route
group (platform staff only, **read-only**).

- **13 sections** — overview, users, organizations (+ detail), subscriptions,
  usage, AI usage, agent runs, crawler jobs, API integrations, errors (+
  detail), audit logs, system health, background jobs. Paged lists with
  explicit Prisma `select`s.
- **Operational metrics** — a hand-rolled in-process registry (counters /
  gauges / histograms) rendered as Prometheus text at `GET /api/metrics` (web,
  token- or staff-gated) and `:$WORKER_HEALTH_PORT/metrics` (worker), plus
  DB-derived durable aggregates (AI tokens / cost / latency, crawler failures,
  job duration, `pg_stat_*`). Covers all ten named metrics.
- **Structured logs + correlation ids** — the worker moves to the shared pino
  factory (redaction); a correlation id is resolved per request in the
  observability layer (`x-correlation-id` from a trusted proxy, else minted)
  and threads into jobs.
- **Errors** — `captureError` folds repeats into a de-duplicated `ErrorEvent`
  row (secret-scrubbed); wired into Next's `onRequestError`, the route wrapper,
  and the worker job wrapper.
- **Health checks** — `GET /api/health` reports database + Redis + AI provider
  - external integrations + worker heartbeat; the worker adds `/healthz`.
- **No secrets** — pino redaction + `scrubSecrets` on free text + explicit
  `select` (no token ciphers) + Stripe-id masking + gated `/api/metrics`.
- Migration `20260916120000_admin_observability` (additive: `ErrorEvent`,
  `WorkerHeartbeat`). ADR-0028. See `docs/OBSERVABILITY.md`.
- **Deferred:** OpenTelemetry spans; pushed alerts (thresholds are shown, not
  sent); abuse-monitoring events + suspend; admin write actions.

### Phase 12 — Hardening & launch ⬜

Full CSP, DAST + external pen test, load tests (crawler, agent runs, webhooks),
RLS coverage audit, DSR export/delete flows, backup-restore drill, runbooks,
observability dashboards + alerts, container hardening, production deploy +
smoke.

### Post-MVP backlog

Scheduled/recurring crawls + monitoring digests · TikTok publishing ·
white-label / custom domains · content calendar + editorial workflow ·
public customer API + outbound webhooks · SSO (OIDC/SAML) + SCIM ·
multi-region / data residency · additional model providers · marketplace
integrations (Zapier/Make).

---

## Phase gate checklist (every phase)

- [ ] Read `CLAUDE.md` + relevant `/docs`
- [ ] Inspect existing code; plan; implement **only** this phase
- [ ] `pnpm lint` · `pnpm typecheck` · `pnpm test` · integration tests · security checks
- [ ] Fix all findings
- [ ] Update affected docs + `DECISIONS.md`
- [ ] Summary · remaining risks · unresolved questions
- [ ] **STOP**
