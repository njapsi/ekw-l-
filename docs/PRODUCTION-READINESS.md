# PRODUCTION-READINESS.md

Independent launch review (operator's "Phase 17"). The whole repository was
inspected against the checklist below, the full test + build pipeline was run,
and findings are classified. **BLOCKER and CRITICAL findings: none.** Two HIGH
findings need attention on the launch checklist; one was fixed in this phase.

> **Verdict:** no blockers. The application is **launch-ready pending the HIGH
> items** on the checklist (§8) — chiefly the `nodemailer` dependency CVEs
> (mitigated, un-bumpable today) and running the Docker + standalone builds on a
> real builder. It is not yet "hardened for scale" — RLS, a full nonce CSP, an
> edge rate-limit layer, load tests and a restore drill remain (roadmap
> "Phase 12").

---

## Review scope

Product · Architecture · Frontend · Backend · Database · AI · Agents · YouTube ·
TikTok · SEO crawler · Billing · Security · Testing · Deployment · Observability
· Documentation — plus a targeted sweep for: TODOs/FIXMEs, mock data, fake
analytics, hard-coded credentials, dev URLs, console logs, unsafe API routes,
missing authz, missing tenant checks, missing validation, missing indexes,
unhandled errors, unused deps, dead code, dependency CVEs, broken links, mobile
behaviour, loading/empty/error states, AI hallucination + prompt-injection
risks, crawler SSRF, billing edge cases, OAuth edge cases.

## Automated checks run

| Check                                                        | Result                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                          | clean                                                                                                      |
| `pnpm lint`                                                  | 14/14 packages, 0 warnings                                                                                 |
| `pnpm typecheck`                                             | 14/14 packages                                                                                             |
| `pnpm test` (unit)                                           | **515 pass** (0 fail)                                                                                      |
| `pnpm test:scripts` (env-validator contract)                 | 9/9                                                                                                        |
| `pnpm --filter @growth-agent/services test:integration`      | self-skips locally (no Docker); **green in CI** against Postgres                                           |
| `pnpm --filter @growth-agent/web build` (normal)             | exit 0                                                                                                     |
| `pnpm --filter @growth-agent/worker build` (typecheck)       | exit 0                                                                                                     |
| Prisma `validate`                                            | schema valid                                                                                               |
| Migrations                                                   | 13 files, **0 DROP statements** — fully additive / expand-contract                                         |
| `pnpm audit --prod`                                          | 8 advisories (3 high, 3 moderate, 2 low) — see H-2 / M-3                                                   |
| `docs` link + ADR reference integrity                        | all resolve                                                                                                |
| Standalone `web` build · `docker build` · live `/api/health` | **not runnable here** (Windows `EPERM` on symlinks; no Docker) — must run on a Linux builder / CI (INFO-1) |

## Positive findings (clean)

- **No** `TODO` / `FIXME` / `HACK` / `XXX` markers in source.
- **No** `any` types in non-test source; **no** `dangerouslySetInnerHTML`,
  `eval`, or `new Function` anywhere.
- **No** empty `catch {}` — every catch handles a specific failure mode (master
  rule H).
- **No** `.env` file tracked by git (only `.env.example`).
- **No** hard-coded credentials, API keys, or secrets in source.
- **Every** API route has an auth guard (session / permission / signature /
  bearer). No unguarded route.
- Tenant scoping is applied consistently — verified at the API routes, the SEO
  agent tools (`resolveCrawl` filters by `ctx.organizationId`), the admin read
  models, and by the Phase 15 `tenant-isolation.integration.test.ts`.
- Migrations are additive and forward-only; the migration history reconstructs
  the current schema (verified transitively — CI runs `migrate:deploy` then
  integration tests that write to every table).
- Grounding checks + deterministic fallbacks exist on every model-narrative
  path (SEO auditor, YouTube/TikTok analysts, content analyze, growth-agent
  synthesis, report summary) — the model may only rewrite prose over
  deterministic facts and is dropped on any grounding failure.

---

## Findings

### BLOCKER

_None._

### CRITICAL

_None._

### HIGH

#### H-1 — Public report export renders a PDF per request with no rate limit · **FIXED**

`GET /r/[token]/export` is unauthenticated and re-runs `renderExport` (the
hand-rolled PDF writer) on every hit with `Cache-Control: no-store`. A recipient
of a shared link (the token is not secret from recipients) could loop the
endpoint for a cheap CPU-amplification DoS on the web tier.

**Fix:** a per-IP `security.checkRateLimit` (30/min) on `/r/[token]/export` and a
per-org+user limit (60/min) on the authenticated `/app/reports/[id]/export`,
plus `Cache-Control: private, max-age=60` (safe — a report snapshot is immutable
once `READY`; short so a revoke still takes effect). Follows the Phase 14
limiter pattern; fails open if Redis is down.

#### H-2 — `nodemailer` 8.x carries 6 open advisories (3 high) · **NOT FIXABLE TODAY — mitigated + on the checklist**

`packages/services` depends on `nodemailer@^8.0.9` for magic-link delivery.
`pnpm audit` flags: "Message-level raw option bypass" (`<=9.0.0`), "Quadratic
O(n²) time complexity" (`<9.1.0`), "resolveContent() bypass", "IDN/Punycode
allow-list bypass", "Recipient-domain validation bypass" (`<9.1.0`), all fixed
in `>=9.1.1`.

**Why it can't be bumped now:** `next-auth@5.0.0-beta.32` (and `@auth/core@0.41.3`)
declare a **hard peer** `nodemailer@"^7.0.7 || ^8.0.5"` — installing v9 produces
an unmet-peer state and `@auth/core`'s Nodemailer provider was written against
the v8 API. Upgrading the NextAuth beta pre-launch is riskier than the residual
exposure (a beta bump already regressed `callbackUrl` once — ADR-0028).

**Why the residual risk is limited:** the app never passes the `raw` option;
`to` is a single address already constrained by `EMAIL_RE`
(`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) client-side **and** NextAuth's own
normalisation; `from` is a fixed env constant; the app does **not** rely on
nodemailer's recipient-domain allow-listing. The O(n²) parse needs a pathological
address our validation rejects.

**Checklist actions (§8):** (a) bump to `nodemailer >= 9.1.1` the moment
`next-auth` GA (or a beta) relaxes the peer; (b) configure SPF + DKIM + DMARC on
the sending domain; (c) add a provider-side send-rate cap; (d) the app-level
magic-link limiter (5/hour/email, Phase 14) already caps volume per address.

### MEDIUM

| #   | Finding                                                                                                                                                                                                                                                                                      | Recommendation                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 | `/admin` had no `loading.tsx` — slow staff pages (some run `pg_stat_*`) showed a blank frame.                                                                                                                                                                                                | **FIXED** — added `app/(admin)/admin/loading.tsx` (skeleton).                                                                                                                            |
| M-2 | `inviteMember` (org invitations) is not rate-limited. ADMIN-gated, and no invite **email** is wired yet, so there is no bombing vector today.                                                                                                                                                | Wire `security.checkRateLimit` into the invite path when invite emails ship.                                                                                                             |
| M-3 | `pnpm audit --prod`: `deepmerge-ts <8` (high) — transitive via the **Prisma CLI's config loader** (build-time, merges Prisma's own config, no attacker input); `ai <5.0.52` + `@ai-sdk/provider-utils <3.0.28` (low) — the AI SDK's file-upload allow-list, a feature this app does not use. | Bump `prisma` to the latest 6.x (pulls a patched `@prisma/config`). `ai` v5 is a breaking major migration across every agent — schedule as its own phase; the flagged feature is unused. |
| M-4 | 4 pages (`youtube/overview`, `youtube/videos`, `tiktok/overview`, `tiktok/videos`) use `<img>` (eslint-disabled) for external CDN thumbnails instead of `next/image`.                                                                                                                        | Perf only (no `srcset`/lazy/AVIF). Add `images.remotePatterns` for the YouTube/TikTok CDNs and switch to `next/image`.                                                                   |
| M-5 | Migration-history ↔ schema consistency and the standalone/Docker builds are only verified **transitively** (CI green).                                                                                                                                                                       | Add an explicit `prisma migrate diff --from-migrations … --to-schema-datamodel …` gate and a `docker build` step to CI before flipping to production.                                    |

### LOW

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                           | Notes                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-1 | Unused deps: `apps/web` declares `@hookform/resolvers` + `react-hook-form` (never imported — the auth form uses plain `useState`), and redundantly `clsx` / `class-variance-authority` / `tailwind-merge` / `pino` (provided transitively by `@growth-agent/{ui,observability}`). `apps/worker` redundantly declares `cheerio` / `fast-xml-parser` / `robots-parser` / `undici` / `zod` (used only via `@growth-agent/services`). | Prune in a housekeeping pass — removing them changes nothing at runtime but shrinks the image and the dependency graph. Not done here (a lockfile change this late needs a Docker + e2e re-validation). |
| L-2 | `packages/services/src/reports/sample.ts` (a `ReportSnapshot` test fixture with `example.com` strings) lives under `src/`. **Not shipped** — no non-test import, not in the barrel.                                                                                                                                                                                                                                               | Rename to `*.fixture.ts` or move under a `__fixtures__/` dir.                                                                                                                                           |
| L-3 | Root `app/error.tsx` / `global-error.tsx` / `(app)/app/error.tsx` call `console.error(error)` (the Next.js error-boundary template). Client-side only.                                                                                                                                                                                                                                                                            | Optionally forward to the observability layer / Sentry.                                                                                                                                                 |
| L-4 | `?? 'http://localhost:3000'` fallbacks for `NEXT_PUBLIC_APP_URL` in ~8 spots (OAuth redirect URIs, Stripe redirect URLs, `metadataBase`).                                                                                                                                                                                                                                                                                         | Dead in production — the var is **required + https-validated** by `scripts/check-env.mjs` and `apps/web/src/env.ts` (boot fails otherwise). Consider replacing the fallback with a hard throw.          |
| L-5 | `redis://localhost:6379` / `smtp://localhost:1025` dev fallbacks.                                                                                                                                                                                                                                                                                                                                                                 | Same — `REDIS_URL` is required in the prod env check. Kept for dev ergonomics.                                                                                                                          |
| L-6 | No `loading.tsx` at sub-route level inside `/app/*` (one shared `(app)/app/loading.tsx`); no app-shell-styled `not-found.tsx` for `/app/*` 404s.                                                                                                                                                                                                                                                                                  | Minor UX polish.                                                                                                                                                                                        |

### INFORMATIONAL

- **INFO-1** — This environment has **no Docker** and the Next standalone build
  fails on Windows (`EPERM` on symlink creation — long-documented). The
  `Dockerfile.web` / `Dockerfile.worker` / `docker-compose.production.yml` and
  the standalone output **must be built + smoke-tested on a Linux builder / CI**
  before production. The standalone output layout was confirmed from the partial
  Windows run and the Dockerfiles follow the canonical Next-monorepo pattern
  (`.next/standalone/apps/web/server.js` + traced `node_modules` + `packages/`).
- **INFO-2** — Postgres RLS is documented as defence-in-depth (`SECURITY.md` §3)
  but not implemented; isolation currently rests entirely on the
  repository/`organizationId` scoping layer, which the audit found consistently
  applied. RLS is roadmap "Phase 3".
- **INFO-3** — The in-process metrics registry resets per web replica per deploy
  (by design — Prometheus stitches it). `/admin` numbers come from the database
  and are stable.
- **INFO-4** — `Notification` model + delivery are not implemented; SEO alerts
  open a `Task` instead (ADR-0027). "Password recovery" is N/A — the product has
  no passwords (magic-link + Google OAuth); the magic link is the recovery path.

---

## 1. Architecture summary

Turborepo + pnpm monorepo, TypeScript `strict` + `noUncheckedIndexedAccess`,
no `any`.

- **`apps/web`** — Next.js 15 App Router (React 19). Public marketing site,
  authenticated app (`/app/*`), read-only `/admin` (platform staff), REST route
  handlers + Server Actions over `packages/services`. JWT sessions (Auth.js v5)
  so edge middleware verifies without a DB; the authoritative revocation +
  active-org checks run in the server layout.
- **`apps/worker`** — BullMQ processors for YouTube / TikTok / SEO-crawl /
  agent-run / content-pipeline / report-generation / automation, plus the
  repeatable "sweep" scheduler, a `WorkerHeartbeat`, and a `/healthz` + `/metrics`
  HTTP listener. Runs from TS source via `tsx` (ADR-0031).
- **`packages/`** — `core` (domain types, Zod schemas, no I/O), `ai`
  (provider-agnostic AI SDK layer + pricing/usage), `db` (Prisma 6 schema +
  checked-in migrations + tenant-scoped repository helpers), `services`
  (all business logic per module — the HTTP layer and the worker share it),
  `ui` (Radix components + Tailwind preset), `observability` (pino + correlation
  - the metrics/health/admin read-model module).
- **Data** — PostgreSQL 16 (+ `pgvector` planned), Redis (BullMQ + rate limits +
  idempotency), S3-compatible object storage (presigned URLs only).
- **Dependency rule** (lint-enforced): `apps/*` → `packages/services` →
  (`db`, `ai`, `core`). `core` has no runtime I/O. `prisma.*` and provider SDKs
  are forbidden outside their owning package.

Full detail: `docs/ARCHITECTURE.md`, `docs/AI-ARCHITECTURE.md`,
`docs/DATABASE.md`, `docs/DEPLOYMENT.md`.

## 2. Implemented capabilities

- **Auth & tenancy** — magic-link + Google OAuth (dev-only credentials provider,
  double-gated), JWT sessions with `sessionVersion` revocation, personal-org
  bootstrap, RBAC (`VIEWER/MEMBER/ADMIN/OWNER` over one policy table, single
  `authorize()` choke point), invitations, audit log.
- **Billing & usage** — Stripe subscriptions via a hand-rolled REST adapter
  (no SDK), config plan catalog (FREE/CREATOR/PRO/AGENCY/ENTERPRISE), checkout /
  portal / upgrade-prorated / downgrade-at-period-end / cancel / resume,
  idempotent signature-verified webhooks, entitlements, and a server-side usage
  meter (`enforceUsage` → 429) wired at the AI / crawl / content / connect
  paths. Runs FREE-for-all with limits enforced when Stripe is unconfigured.
- **YouTube growth agent** — Google OAuth (read-only scopes; monetary opt-in),
  AES-256-GCM token envelope, proactive + 401 refresh, Data + Analytics API
  clients with typed failure modes, incremental sync, derived metrics, a
  grounded YouTube Analyst Agent + a conservative monetization assessment,
  7-tab dashboard.
- **TikTok growth agent** — Login Kit + PKCE, Display API client, incremental
  sync, a grounded TikTok Analyst Agent, and **authorized publishing**
  (Content Posting API, explicit approval, duplicate guard, status polling).
- **Technical SEO crawler + AI SEO agent** — the authoritative SSRF/DNS-rebinding
  guard (`ssrf.ts`), an SSRF-safe pinned-socket fetch client, robots + sitemap
  parsing, ownership verification, ~38-rule auditor with published scoring
  weights, a bounded orchestrator with pause/resume/cancel + a kill switch, a
  headless renderer that re-applies the SSRF allowlist to every subresource,
  and a nine-tool **read-only** SEO agent (no write path).
- **Unified Growth Agent** — a conversational agent over seven tenant-scoped,
  mutation-free capability wrappers; deterministic planner; grounded structured
  synthesis with a deterministic fallback; controlled `OrgMemory`
  (secret-redacted, length-capped); conversation search / export;
  recommendation → `Task`. External actions are proposed, never executed.
- **Content repurposing** — SOURCE → analysis → key ideas → angles → 13
  platform deliverables → approval → publish/schedule markers. Never fetches or
  transcribes; never publishes (status marker only).
- **Monetization intelligence** — deterministic opportunity engine over 11
  channels (labels, never currency figures), an optional grounded prose pass,
  user-entered-only revenue, promote-to-`Task`.
- **Reporting** — 7 report types × 7 fixed sections, immutable `ReportSnapshot`,
  on-demand PDF/CSV/JSON export from a hand-rolled PDF writer (no Chromium),
  public redacted `/r/<token>` share links.
- **Automation engine** — DB-defined rules (7 task types, none publish
  externally), a hand-rolled cron, a 60s worker sweep + 30s retry-sweep,
  owner-permission re-check at run time, retry + exponential backoff +
  idempotency + escalation, full execution log.
- **Admin & observability** — 13 read-only `/admin` sections, an in-process
  metrics registry + `/api/metrics` + worker `/metrics`, DB-derived operational
  dashboards, structured logs with correlation ids, de-duplicated `ErrorEvent`
  rows, health checks for database / Redis / AI provider / integrations /
  worker.
- **Security hardening** — session-bound OAuth callbacks, a fail-open Redis rate
  limiter, a Content-Security-Policy, an untrusted-content fence for prompts,
  `timingSafeEqual` on `/api/metrics`, broadened log redaction
  (`docs/SECURITY-AUDIT.md`).
- **Deployment prep** — two Dockerfiles, production compose + Caddy, Prometheus
  scrape + alert rules, pg backup/restore scripts, and a zero-dependency env
  validator that never prints a secret value (`docs/DEPLOYMENT.md`,
  `scripts/check-env.mjs`).

## 3. Remaining limitations

- **No RLS** — tenant isolation is application-layer only (verified consistent).
- **CSP is not nonce-based** — `script-src` keeps `'unsafe-inline'` (App Router
  inline hydration); external script/frame/object origins are blocked but a
  strict nonce policy is a tracked follow-up.
- **Rate limiting is app-level + fail-open** — no edge/WAF/IP layer yet; no
  aggregate magic-link cap across many target addresses; invitations
  unthrottled.
- **`Notification` model + delivery unimplemented** — SEO alerts open a `Task`;
  digests / in-app notifications not built.
- **Automations are UTC-only** — `timezone` is stored but not honoured.
- **The general model-driven orchestrator / `generateWithTools` / `pgvector`
  semantic memory / agent kill switches** are not built (only the fixed
  capability registries).
- **SEO raw-HTML archiving to object storage** is deferred; the crawl-pool
  egress isolation is a platform-selection criterion, not yet configured.
- **Billing follow-ups** — no worker queue for reconcile/counter-rollup (runs
  inline), no Stripe usage-record push for metered overage.
- **Observability follow-ups** — no OpenTelemetry tracing spans; alert
  thresholds are unvalidated defaults; no pushed alerting wired
  (Alertmanager not deployed).
- **e2e** — deep data-flow browser tests (run a real crawl/report/agent turn
  through the UI) are covered at the integration layer, not e2e.

## 4. Known third-party API limitations

- **YouTube Data API v3** — 10,000 units/day default quota; a quota increase is
  required for multi-tenant scale. `YOUTUBE_ORG_DAILY_QUOTA` slices it per
  connected account. Analytics has ~2-3 day data latency.
- **YouTube monetization** — the app **never** claims YPP eligibility; readiness
  is a conservative local assessment and defers to YouTube (ADR-0024).
- **TikTok** — an **unaudited** app can only post `SELF_ONLY` (private) videos
  and has limited Display API access; audit approval (with a demo video +
  privacy policy) is required for public posting and full read access. TikTok
  has **no daily analytics API** — metrics are manual snapshots.
- **Google OAuth** — sensitive-scope verification (the YouTube Analytics scopes)
  takes days-to-weeks; start early. Unverified apps are capped at 100 users and
  show an "unverified" screen.
- **Stripe** — the Customer Portal must be enabled in the dashboard for
  `changePlan`/`cancel` handoff; webhooks retry with backoff (the ledger is
  idempotent); an unknown price on a subscription keeps the current tier.
- **AI providers** — `packages/ai/pricing.ts` cost estimates are conservative
  and lag published prices; unknown models estimate cost as 0 and are flagged.
  Provider-side rate limits + spend caps must be set independently.
- **The crawler** obeys `robots.txt` and records `BLOCKED` rather than evading;
  it will not crawl beyond a shallow public sample (≤10 pages, depth 1) until a
  `Website` is ownership-verified.

## 5. Security status

**Audited in Phase 14** (`docs/SECURITY-AUDIT.md`): 0 Critical, 2 High, 3
Medium — **all Critical/High fixed** (session-bound OAuth callbacks; a Redis
rate limiter on the sensitive endpoints; a CSP; token-in-log path closed;
`timingSafeEqual`). This Phase-17 pass found **0 new blockers/criticals**, fixed
one HIGH (H-1, public export DoS), and flagged one un-bumpable HIGH (H-2,
`nodemailer` CVEs — mitigated, on the checklist).

Standing controls: AES-256-GCM OAuth token envelope with a `keyId` for rotation;
HMAC-signed OAuth `state` bound to the session; Stripe webhook HMAC verified
before parse with a ±300s replay window; SSRF guard (resolve-then-pin, mixed-DNS
refusal, per-redirect re-validation, scheme/port allowlist, byte + decompression
caps); read-only, org-scoped, no-command AI tool registries; four-layer
secret-scrubbing in `/admin`; parameterised SQL only (4 constant `$queryRaw`,
0 `$queryRawUnsafe`); no `eval` / `child_process` / `dangerouslySetInnerHTML`;
`AppError.expose` gates every client-facing error message.

Open (non-blocking): RLS, nonce CSP, edge rate-limit layer, `nodemailer` bump,
DAST / external pen test (not yet performed), the `deepmerge-ts` / `ai`
advisories (build-time / unused feature).

## 6. Testing status

- **515 unit tests** across 90 files, all green. Zero suppressed/skipped tests
  (integration + authed-e2e self-skip only when their infra is absent).
- **Integration** — real-Postgres suites for tenant isolation, automation-tick
  idempotency under concurrency, Stripe webhook dedupe under concurrency, and
  the crawler / sync / orchestrator / content pipelines. Run in CI against a
  Postgres service.
- **E2E (Playwright)** — public-surface + route-protection smoke, an HTTP
  API-contract suite (headers/CSP, health shape + burst-safety, metrics auth,
  webhook, OAuth callback, share-token), a UI suite (auth-form failure states,
  375px mobile no-overflow on every public page), and an authenticated
  browser suite (dashboard, empty state, VIEWER-vs-OWNER gating, `/admin` staff
  access, session revocation) gated by `E2E_AUTHED=1` + Postgres in CI.
- `docs/QA.md` is the area × layer × where-it-runs coverage map.
- **Gaps:** no load / soak tests; no DAST; deep UI data-flow e2e is at the
  integration layer.

## 7. Deployment status

**Prepared, not executed** (Phase 16). Two Dockerfiles (`web` standalone,
`worker` + Chromium), `docker-compose.production.yml` (+ Caddy auto-TLS + a
one-shot `migrate` service), `deploy/` (Caddyfile, Prometheus, alerts, pg
backup/restore), `scripts/check-env.mjs`, and a 17-step `docs/DEPLOYMENT.md`
(prod DB · Redis · object storage · AI provider · Google OAuth · YouTube APIs ·
TikTok app · payments · domain · DNS · env vars · migrations · app deploy ·
worker deploy · cron · monitoring · rollback).

Production requirements are all addressed in the runbook: HTTPS (Caddy/platform
TLS), secure cookies (automatic on https), managed Postgres/Redis/object
storage, secrets from the platform store, provider PITR + a portable pg-dump
backup, migrations as a release step (never at boot), Prometheus monitoring +
alert rules, the app-level rate limiter, and CDN cache headers for static assets.

**Not verified here (INFO-1):** a real `docker build` of either image, the Next
standalone build, and a live `/api/health` against the built container — all
blocked by this environment (no Docker; Windows standalone `EPERM`). CI builds
the standalone `web` and runs migrations + integration + e2e against Postgres.

## 8. Recommended launch checklist

**Must do before flipping DNS:**

1. On a Linux builder / CI: `docker build -f Dockerfile.web .` and
   `-f Dockerfile.worker .` succeed; `docker compose -f docker-compose.production.yml
up -d` comes up healthy; `curl https://…/api/health` → `status: ok` and the
   worker `/healthz` → 200.
2. `node scripts/check-env.mjs --file .env.production --target all` → **0
   blocking** with the real production secret store.
3. `prisma migrate diff --from-migrations ./prisma/migrations
--to-schema-datamodel ./prisma/schema.prisma` (against a shadow DB) shows
   **no drift**; then run `migrate:deploy` in the release step after a backup.
4. Add SPF + DKIM + DMARC for the magic-link sending domain; set a provider-side
   send-rate cap (mitigation for **H-2**).
5. Restore drill: run `deploy/backup/pg-restore.sh` into a scratch DB from a
   fresh `pg-backup.sh` dump; confirm `migrate:deploy` reports "at head".
6. Google OAuth consent screen **verified** for the YouTube Analytics scopes
   (or launch with the 100-user cap acknowledged).
7. TikTok app **audit-approved** if public posting / full Display API is in the
   launch scope (else document the `SELF_ONLY` limitation to users).
8. Stripe: live keys + all 6 Price IDs + the webhook endpoint + the Customer
   Portal enabled; send a test event and confirm the `BillingEvent` ledger.
9. Deploy Prometheus with `deploy/prometheus.yml` + `deploy/alerts.yml` wired to
   a real Alertmanager (PagerDuty/Slack); tune the thresholds against a day of
   traffic.
10. An external uptime monitor on `/api/health` (60s) alerting on non-200 or
    `status: "down"`.
11. Set a per-provider AI spend cap (Anthropic/OpenAI/Google console) in
    addition to the `AiCostBurnRate` alert.
12. Confirm `AUTH_DEV_LOGIN` is unset, `NODE_ENV=production`, and
    `AUTH_URL == NEXT_PUBLIC_APP_URL` (the canonical https origin) in the
    deployed env.
13. Configure the crawl-pool egress isolation (network policy / egress proxy)
    on the chosen platform — the app-level SSRF guard is the second line.

**Should do soon after launch (HIGH/MEDIUM follow-ups):**

14. Bump `nodemailer` ≥ 9.1.1 once `next-auth` relaxes the peer (**H-2**).
15. Bump `prisma` to the latest 6.x to clear `deepmerge-ts` (**M-3**);
    schedule the `ai` v5 SDK migration as its own phase.
16. Rate-limit the invitation path when invite emails ship (**M-2**);
    switch the 4 thumbnail pages to `next/image` (**M-4**); add the
    `migrate diff` + `docker build` gates to CI (**M-5**).
17. Prune the unused deps (**L-1**), move `reports/sample.ts` to a fixtures dir
    (**L-2**).

**Roadmap ("Phase 12 — Hardening & launch") — not launch blockers:**

18. Postgres RLS · a strict nonce-based CSP · an edge/IP rate-limit layer ·
    DAST + external pen test · load / soak tests · the `Notification` system ·
    OpenTelemetry tracing · DSR export/delete flows.
