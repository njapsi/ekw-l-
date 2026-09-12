# CLAUDE.md — Growth Agent

Project-specific development instructions. Read this **and** the relevant
`/docs/*.md` before starting any phase. The authoritative product spec is
`Claude Code Master Project Instruction.pdf` (repo root).

---

## What this is

A **production-grade multi-tenant SaaS**: an AI-powered growth agent for YouTube
creators, TikTok creators, website owners, SEO professionals, and agencies. It
turns connected analytics and website crawl data into **prioritized, explainable
recommendations**. Not a demo, prototype, or toy.

---

## Stack (finalized in Phase 1 — see `docs/DECISIONS.md`)

- **Language:** TypeScript, `strict` + `noUncheckedIndexedAccess`. No `any`.
- **Frontend:** Next.js 15 (App Router), React 19, Tailwind, Radix-based
  `packages/ui` component system.
- **API:** Next.js Route Handlers + Server Actions over `packages/services`.
  No separate backend framework (ADR-0006). Dedicated `apps/worker` for jobs.
- **DB:** PostgreSQL 16 + Prisma 6. Checked-in migrations. Tenant isolation is
  app-layer (every query scoped by `organizationId`) + integration-tested +
  a CI `check:tenant` lint; **Postgres RLS is a tracked follow-up, not yet
  implemented** (ADR-0035). `pgvector` for semantic memory (planned).
- **Auth:** Auth.js (NextAuth v5) + Prisma adapter, **JWT sessions** (ADR-0011,
  so edge middleware can verify without a DB). Magic-link (delivery via
  `EMAIL_TRANSPORT` = `resend` | `smtp` | `console`) + Google + a dev-only
  credentials provider (`AUTH_DEV_LOGIN`). A prod deploy must have ≥1 real
  sign-in path or boot fails (`config/env.ts`). RBAC/tenancy are ours:
  `authorize()` policy table + `withOrgScope`/`requireMembership` + `sessionVersion`
  revocation.
- **Jobs + cache:** BullMQ on Redis; Redis also for cache, rate limits,
  idempotency, crawl frontier.
- **Object storage:** _planned, not implemented_ — S3-compatible with presigned
  URLs is the intended design; no code reads `S3_*` today (nothing depends on it
  — reports render on demand). See `docs/FORENSIC-AUDIT.md`.
- **AI:** Vercel AI SDK behind `packages/ai`. Never import a provider SDK from
  `apps/*` or `packages/services` — go through the registry / model roles.
- **Observability:** pino (JSON), an in-process metrics registry at `/metrics`,
  health checks, de-duplicated `ErrorEvent` rows (server + client + edge, the
  last two via `/api/client-error`). **Sentry and OpenTelemetry are planned, not
  implemented** — no `@sentry/*` / `@opentelemetry/*` dependency.
- **Testing:** Vitest (unit + integration), Playwright (e2e).
- **Deploy:** Docker images for `web` and `worker`; docker-compose locally.

---

## Repository layout (target)

```
apps/web        Next.js — public site, app, /admin, API routes, Server Actions
apps/worker     BullMQ processors, schedulers, heartbeats
packages/core   domain types, Zod schemas, Result, agent/orchestrator contracts (no I/O)
packages/db     Prisma schema, client, migrations, seed, repository helpers
packages/ai     provider-agnostic AI layer (interface, registry, providers, pricing, usage)
packages/services  business logic per module (auth, org, billing, usage, ai, integrations,
                   youtube, tiktok, seo, crawler, content, recommendations, reports,
                   tasks, notifications, audit)
packages/ui     Radix-based accessible components + Tailwind preset (@growth-agent/ui/tailwind-preset)
packages/observability  pino logger + request-correlation helpers
docs/           architecture + product documentation
```

`packages/config` was deferred — its Tailwind preset lives in `packages/ui`,
and shared eslint/tsconfig presets stay at the repo root (ADR-0012). Workspace
`.js` import specifiers are remapped for the Next build in
`apps/web/next.config.mjs`.

**Dependency rule:** `apps/*` → `packages/services` →
(`packages/db`, `packages/ai`, `packages/core`). `apps/web` and `apps/worker`
never import each other. `packages/core` has **no runtime I/O**. Business logic
lives in `packages/services` so the HTTP layer and the worker share it — a lint
rule forbids `prisma.*` and provider SDKs outside their owning package.

> Phase 0 shipped `core`, `ai`, `db`, `web`, `worker`. `services`, `ui`,
> `config`, `observability` are created in Phase 2+. Until then, small logic
> lives under `apps/web/src/modules/*` and migrates out as it grows.

---

## Hard rules (from the master instruction)

1. **Never fabricate analytics or API data.** If an API didn't return it, say
   so. Tag every statement `fact | calculated_metric | assumption | prediction |
recommendation` (`packages/core` `Claim`). "No data" is a valid answer.
2. **No guarantees.** Never claim monetization approval, revenue, or search/AI
   rankings are guaranteed.
3. **Tenant isolation is mandatory.** Every tenant query is scoped by
   `organizationId` via `packages/db` repositories; RLS as backstop. The active
   org comes from the session, never from request input.
4. **Human approval.** `external`/`destructive` actions (publishing, metadata
   changes, external settings, deletions) require explicit user approval unless
   the org enabled automation mode. Default `requiresApproval = true`.
5. **Agents are constrained.** Specialized agents only, each with an explicit
   `allowedTools`. No raw DB handle to an agent. Untrusted content (crawled
   HTML, metadata, API payloads, user text) is data, never instructions.
6. **Secrets stay server-side.** Only `NEXT_PUBLIC_*` reaches the browser. OAuth
   tokens encrypted at rest (`ENCRYPTION_KEY`, AES-256-GCM). Never log tokens.
7. **The crawler is bounded.** Robots-aware, SSRF-safe, ownership-gated,
   network-isolated. No endpoint fetches an arbitrary user URL and returns its
   body. See `docs/SEO-ENGINE.md` §2.
8. **Don't swallow errors.** Use the `Result` type or throw; never an empty
   `catch`. Structured logging via pino with correlation ids.
9. **Small modules over giant files.** Don't duplicate business logic. Prefer
   maintainability over cleverness. Avoid unnecessary dependencies.
10. **Don't fake missing capabilities.** If an external API lacks something,
    build an abstraction and document the limitation in the relevant
    `docs/*-INTEGRATION.md` / `docs/SEO-ENGINE.md`.
11. **Metering before work.** Every metered operation calls
    `usage.check(org, meter, amount)` before doing it and `usage.record(...)`
    after. Enforcement is centralized in the `usage` module.

---

## Per-phase workflow (non-negotiable)

1. Read `CLAUDE.md` and the relevant `/docs` files.
2. Inspect the existing implementation. Don't assume files exist. Don't rebuild
   what works. Don't overwrite working code unnecessarily.
3. Write a plan. Implement **only** the requested phase.
4. `pnpm lint` · `pnpm typecheck` · `pnpm test` · integration tests (where
   applicable) · security checks.
5. Fix everything that broke.
6. Update the affected `/docs` files and `DECISIONS.md`.
7. Summarize changes; list remaining risks and unresolved questions.
8. **STOP.** Do not start the next phase automatically.

If requirements conflict, name the conflict and choose the safest production
architecture (record it in `DECISIONS.md`).

---

## Commands

```bash
pnpm install
pnpm db:generate          # prisma generate
pnpm db:migrate           # prisma migrate dev  (needs Postgres)
pnpm dev                  # all apps via turbo
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @growth-agent/web test:e2e
pnpm format               # prettier write
```

---

## Current state

- **Phase 0** ✅ scaffold.
- **Phase 1** ✅ product architecture (the `/docs` set).
- **Phase 2** ✅ web application foundation: `packages/ui`, `packages/observability`,
  `packages/services` (`auth`, `rbac`, `organizations`, `users`, `audit`), first
  Prisma migration, Auth.js (JWT), RBAC + tenancy helpers, public marketing
  pages, authenticated app shell + all `/app/*` routes (empty states),
  settings, onboarding, read-only `/admin`, error/loading/not-found, health,
  test infra (unit + gated integration + Playwright smoke), `docker-compose.yml`.
- **YouTube growth agent** ✅ (operator's "Phase 3"; roadmap Phase 8 + a slice of
  Phase 5): `packages/services/integrations` (Google OAuth, signed state,
  AES-256-GCM token envelope in `crypto/tokens.ts`, `withFreshAccessToken`,
  health + quota) and `packages/services/youtube` (typed Data/Analytics API
  client with failure modes, incremental sync, derived metrics, the **YouTube
  Analyst Agent** with a fact sheet + grounding check, and the monetization
  assessment). Second Prisma migration (`OAuthConnection`, `IntegrationHealth`,
  `YouTubeChannel/Video/Metric/SyncRun`, `AgentRun`, `Recommendation`,
  `ContentIdea`). `/app/youtube/*` dashboard (7 tabs) + `/app/integrations/youtube`
  - OAuth routes + worker `youtube-sync` queue. See `docs/YOUTUBE-INTEGRATION.md`.
- **TikTok growth agent** ✅ (roadmap Phase 9): `packages/services/integrations`
  generalized to a provider-OAuth registry (ADR-0016); `tiktok-oauth.ts`
  (Login Kit + PKCE, ADR-0015); `packages/services/tiktok` (Display API client
  with typed failure modes, incremental account/video sync, derived metrics,
  the **TikTok Analyst Agent** on the shared grounding check, and **authorized
  publishing** via the Content Posting API — `PULL_FROM_URL`, explicit approval,
  duplicate-publish guard, status polling, audit, ADR-0017). Third Prisma
  migration (`TikTokAccount/Video/Metric/SyncRun`, `TikTokPublish`).
  `/app/tiktok/*` dashboard (6 tabs incl. Publishing) + `/app/integrations/tiktok`
  - OAuth routes + worker `tiktok-sync` queue. See `docs/TIKTOK-INTEGRATION.md`.
- **Technical SEO crawler** ✅ (roadmap Phase 6; operator's "Phase 5"):
  `packages/services/seo` — the authoritative SSRF/DNS-rebinding guard
  (`ssrf.ts`, ADR-0019: resolve-then-pin, reject-mixed-DNS, IPv4/IPv6 range
  table, per-redirect re-validation), safe fetch client (byte + decompression
  caps, credential stripping, injectable transport), robots.txt + sitemap
  parsers, cheerio HTML extraction, simhash fingerprints, in-memory frontier
  (ADR-0018), per-host rate limiter + concurrency + retry/backoff, render
  decision + `PageRenderer` seam (Playwright adapter in `apps/worker` with an
  SSRF-safe subresource interceptor), link-graph analysis, ~38-rule technical
  auditor, category scoring with published weights (`scoring.ts`, ADR-0020),
  the `crawler.ts` orchestrator (max pages/depth/time, pause/resume/cancel,
  kill switch `CRAWLER_HALT`), ownership verification (DNS TXT / HTML file), and
  the grounded **SEO Auditor Agent** (`seo-auditor`, `Recommendation.domain =
SEO`). Fourth Prisma migration (`Website`, `Crawl`, `CrawlPage`, `CrawlLink`,
  `CrawlIssue`). `/app/seo` UI (add + verify website, crawl config + controls,
  score cards, issue list, architecture, AI summary) + worker `seo-crawl`
  queue. See `docs/SEO-ENGINE.md`.
- **AI SEO Agent** ✅ (roadmap Phase 7 slice; operator's "Phase 6"):
  `packages/services/seo/agent-tools.ts` — a closed allowlist of **nine
  read-only** `seo.get_*` tools (project, crawl, page, issues, internal_links,
  sitemap, robots, schema, site_architecture), no write path (ADR-0021);
  `recommendation-engine.ts` — deterministic six-factor priority score
  (severity, reach, business importance + goal nudge, estimated impact, ease,
  confidence) + four action plans (Quick Wins / High Impact / Technical
  Projects / Long-Term); `ai-readability.ts` — nine machine-readability signals
  (semantic HTML, structured data, entity consistency, hierarchy, descriptive
  URLs, internal links, content relationships, metadata, machine signals) each
  labelled established vs experimental; `agent.ts` — gathers evidence via the
  tools (never crawls), ranks deterministically, optional grounded model
  narrative with a deterministic fallback (drop on grounding failure, numbers
  unaffected), free-form Q&A. Fifth Prisma migration
  `20260909120000_seo_agent` (additive: `Recommendation.priorityScore/actionPlan/
affectedUrlCount/businessImportance`, `CrawlPage.landmarkCount/hasMainLandmark/
jsonLdEntities`). `/app/seo/.../crawls/[crawlId]` agent panel + report;
  `seo-crawl` worker `agent.run` job.
- **Unified AI Growth Agent** ✅ (roadmap Phase 7; operator's "Phase 7"):
  `packages/services/src/agent` — a conversational agent at `/app/agent`.
  `capabilities.ts` — a fixed registry of seven tenant-scoped wrappers
  (`org-context` always first, `youtube-analyst`, `youtube-monetization`,
  `tiktok-analyst`, `seo-agent`, `content-repurpose`, `growth-plan`), none of
  which can mutate anything; `planner.ts` — deterministic keyword router,
  model-refined, one-line rationale (no CoT); `orchestrator.ts` —
  gather → plan → execute → collect evidence → grounded `generateObject`
  synthesis into `GrowthAgentResponse` (analysis summary · evidence ·
  decisions · recommendations · actions) with a deterministic fallback →
  `streamText` reply, all as an SSE stream (`/api/agent/stream`); `memory.ts` —
  controlled `OrgMemory` (six kinds, secret-redacted + length-capped on every
  write, incl. the model extractor); `conversations.ts` — list / rename /
  soft-delete / search (title + content) / export (md, json); `tasks.ts` —
  recommendation → `Task` (Title / Priority / Affected URLs / Instructions /
  Status), DONE → `COMPLETED_TASK` memory. External-system actions are
  **proposed with `requiresConfirmation`, never executed** by the agent
  (ADR-0022). Sixth Prisma migration `20260910120000_growth_agent`
  (`AIConversation`, `AIMessage`, `OrgMemory`, `Task`). `/app/agent` (chat +
  sidebar) and a real `/app/tasks`; `agent-run` worker queue.
- **Content repurposing engine** ✅ (operator's "Phase 8"):
  `packages/services/src/content` — pipeline SOURCE → CONTENT ANALYSIS → KEY
  IDEAS → CONTENT ANGLES → PLATFORM-SPECIFIC CONTENT → APPROVAL →
  PUBLISH/SCHEDULE. `ingest.ts` (source = synced YouTube video / URL+pasted
  text / transcript / manual — **never fetches or transcribes**, ADR-0023);
  `analyze.ts` (one grounded `generateObject` → `ContentAnalysis`; light
  grounding — verbatim quotes only, guarantee phrasing → deterministic
  fallback); `generate.ts` (13 deliverable types — YT title alternatives,
  descriptions, chapters, Shorts/TikTok ideas, TikTok captions, hooks, scripts,
  social posts, blog ideas, SEO outlines, FAQs, newsletter ideas — each → a
  `ContentAsset` + `ContentAssetVersion` v1, status DRAFT); `assets.ts`
  (edit → new version + reset to DRAFT; approve; schedule (future only);
  **markAssetPublished = status marker, the engine never publishes**; markFailed;
  revert (appends a copy); regenerate; every transition audit-logged). Seventh
  Prisma migration `20260911120000_content_repurposing` (`RepurposeProject`,
  `ContentAsset`, `ContentAssetVersion`). New RBAC action `content:manage`
  (MEMBER+). `/app/content` UI + `content-pipeline` worker queue. See
  `docs/CONTENT-REPURPOSING.md`.
- **Monetization intelligence engine** ✅ (operator's "Phase 9"):
  `packages/services/src/monetization` — `signals.ts` (deterministic snapshot:
  connected YouTube/TikTok/SEO data + the user-provided `BusinessProfile` +
  a read-only revenue summary); `engine.ts` (`buildOpportunities` — one
  `OpportunityDraft` per applicable channel across **11 channels**, each with
  the seven required fields — Opportunity, Evidence, Audience fit, Estimated
  difficulty, Estimated potential, Required action, Confidence — plus a
  `priorityScore`; estimates are labels `Low`/`Moderate`/`High`, **never a
  currency figure**; `PLATFORM_MONETIZATION` readiness derives entirely from
  the conservative `assessMonetization` output and **never claims the creator
  qualifies** — YouTube decides, ADR-0024); `analyst.ts` (`runMonetizationScan`
  — optional grounded model prose pass, dropped on any grounding failure;
  persisted as `AgentRun` `monetization-analyst`; dedupes on `(org, channel)`
  keeping a user-advanced status); `opportunities.ts` (status lifecycle +
  promote-to-`Task`, never targets an external system); `revenue.ts`
  (**user-entered only** — `RevenueEntry.createdById` required, soft delete,
  `getRevenueSummary` with a `YYYY-MM` monthly history); `read.ts`
  (`getMonetizationDashboard`). Eighth Prisma migration
  `20260912120000_monetization` (additive: `BusinessProfile`,
  `MonetizationOpportunity`, `RevenueEntry`). New RBAC action
  `monetization:manage` (MEMBER+). `/app/monetization` UI; scan runs inline
  (`runMonetizationScanJob` wired for a future scheduled re-scan, no queue
  added). See `docs/MONETIZATION.md`.
- **Billing & usage** ✅ (roadmap Phase 4; operator's "Phase 10"):
  `packages/services/src/billing` + `packages/services/src/usage`.
  `billing/plans.ts` — the **config plan catalog** (FREE / CREATOR / PRO /
  AGENCY / ENTERPRISE; display price + per-meter limits + feature flags; prices
  never hard-coded per call site, Stripe Price IDs are env config, ADR-0025).
  `billing/gateway.ts` — `BillingGateway` behind a **hand-rolled Stripe REST
  adapter** (`fetch` + form encoding; webhook HMAC via `node:crypto`; **no SDK,
  no new dependency**) and a `NullBillingGateway` for when Stripe is
  unconfigured (app runs FREE-for-all, limits still enforced).
  `subscription.ts` (1:1 mirror; unknown price keeps the tier), `checkout.ts`
  (checkout + portal), `plan-change.ts` (upgrade prorated / downgrade at period
  end / cancel-at-period-end / resume), `entitlements.ts` (PLAN rows from the
  catalog + OVERRIDE/PROMO), `webhook.ts` (**idempotent**: a `BillingEvent`
  ledger keyed on the Stripe event id + stripe-id-keyed upserts; bad sig → 400;
  unknown type → SKIPPED), `reconcile.ts` (nightly self-heal). The **`usage`
  module** — `checkUsage` → do work → `recordUsage` (idempotent on
  `idempotencyKey`, counter incremented in the same tx as the ledger insert),
  `enforceUsage` throws `usage_limit_exceeded` (429) **server-side**,
  `refreshUsageCounters` rebuilds from the ledger, gauges (seats, connected
  accounts) read a live count. Meters: `AI_REQUESTS`, `AI_TOKENS`, `CRAWLS`,
  `CRAWL_PAGES`, `CONNECTED_ACCOUNTS`, `REPORTS`, `CONTENT_GENERATIONS`,
  `SEATS`. Enforcement wired at the SEO crawl action, the content-generation
  action, the agent-stream route + growth-agent job (AI meters), and the OAuth
  connect routes. Ninth Prisma migration `20260913120000_billing` (additive:
  `Subscription`, `Entitlement`, `UsageRecord`, `UsageCounter`, `Invoice`,
  `BillingEvent`). `billing:manage` (already OWNER-only) guards the Server
  Actions. `/api/billing/webhook` + `/app/billing` UI + config-driven
  `/pricing`. New env `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` /
  `STRIPE_PRICE_*` (all optional). See `docs/BILLING.md`.
- **Reporting engine** ✅ (operator's "Phase 11"):
  `packages/services/src/reports` — one report per area across **seven types**
  (`YOUTUBE`, `TIKTOK`, `SEO`, `WEBSITE_HEALTH`, `AI_RECOMMENDATIONS`, `GROWTH`,
  `MONETIZATION`), each with the same **seven sections** (Executive Summary ·
  Key Metrics · Problems · Opportunities · Recommendations · Priority Actions ·
  Historical Changes). `facts.ts` (deterministic per-type gathering from the
  module read functions; never invents a number), `sections.ts` (deterministic
  assembly + the metric diff vs the previous report), `summary.ts`
  (deterministic exec summary, or one grounded model pass dropped on any
  grounding failure), `build.ts` → `generate.ts` (**immutable `ReportSnapshot`**
  written once on `READY`; regenerate = a new row linked via `previousReportId`;
  `usage.enforceUsage({ meter: 'REPORTS' })` server-side then `recordUsage`;
  FAILED path recorded). `pdf/` — a **hand-rolled ~200-line PDF writer**
  (base-14 Helvetica, embedded width table, wrapping / tables / page-breaks;
  **no dependency, no Chromium**); `export/` — `renderExport` → PDF / CSV
  (pure) / JSON, **rendered on demand from the snapshot** (no object storage).
  `share.ts` + `redact.ts` — a public `/r/<token>` view that serves
  `redactSnapshotForPublic(snapshot)` **only** (generic subject/org labels,
  free text scrubbed of emails/URLs/handles/ids, monetary amounts hidden);
  unknown/expired/revoked token → 404. New RBAC actions `report:generate`
  (MEMBER+) and `report:share` (ADMIN+); `report:read` (VIEWER+) unchanged.
  Tenth Prisma migration `20260914120000_reporting` (additive: `Report`).
  `/app/reports` list + `/app/reports/[id]` detail + `/app/reports/[id]/export`
  - public `/r/[token]` + `/r/[token]/export`; `report-generation` worker queue
    now has a real processor. New `ReportSnapshot` contract in `packages/core`.
    See `docs/REPORTING.md`.
- **Automation engine** ✅ (operator's "Phase 12"):
  `packages/services/src/automation` — user-defined `AutomationRule` rows
  (id / organization / owner / task type / schedule / config / last run /
  next run / status / failure count) with **seven task types**
  (`YOUTUBE_ANALYSIS`, `TIKTOK_ANALYSIS`, `WEBSITE_CRAWL`, `SEO_ISSUE_ALERT`,
  `MONETIZATION_SCAN`, `GROWTH_REPORT`, `CONTENT_OPPORTUNITY` — **none publish
  externally**, `assertNoExternalPublish()` invariant). `cron.ts` — a
  hand-rolled 5-field cron parser + `nextRunAfter` (UTC, no dependency).
  `rules.ts` — CRUD; the owner's permission for the task's `requiredAction` is
  checked on create/update. `runner.ts` — `claimRun` (idempotent via
  `@@unique([automationRuleId, scheduledFor])`), `executeAutomationRun`
  (**re-checks the owner's RBAC → SKIPPED + rule PAUSED if the role was lost**;
  success resets `failureCount` + reschedules; failure → `RETRY_SCHEDULED` with
  exponential backoff to `maxRetries`, then `FAILED`; 5 consecutive → `FAILING`,
  10 → `DISABLED`), `cancelRun`. `dispatch.ts` — maps each task type to the
  existing job wrapper; `SEO_ISSUE_ALERT` / `CONTENT_OPPORTUNITY` open a `Task`.
  New `automation` BullMQ queue with **two repeatable ticks** (`sweep` 60s,
  `retry-sweep` 30s) registered by the worker on start. Eleventh Prisma
  migration `20260915120000_automation` (additive: `AutomationRule`,
  `AutomationRun`). New RBAC action `automation:manage` (MEMBER+).
  `/app/automations` list + `/app/automations/[id]` detail with the execution
  log. See `docs/AUTOMATION.md`.
- **Admin & observability** ✅ (operator's "Phase 13"):
  `packages/services/src/observability` — one shared module for the web app and
  the worker. `metrics.ts` — a hand-rolled in-process registry (counters /
  gauges / fixed-bucket histograms) rendered as Prometheus text at
  `GET /api/metrics` (web; `Bearer $METRICS_TOKEN` or platform-staff) and
  `:$WORKER_HEALTH_PORT/metrics` (worker). `scrub.ts` — `scrubSecrets` /
  `scrubContext` for inline redaction of free text. `errors.ts` —
  `captureError` folds repeated faults into one de-duplicated `ErrorEvent` row
  (secret-scrubbed, capped); wired into Next's `onRequestError`, the
  `withRouteObservability` wrapper, and the worker's `instrumentJob`.
  `health.ts` — `runHealthChecks` over database + Redis + AI provider +
  external integrations + worker heartbeat (`GET /api/health`, always 200).
  `redis.ts` / `queues.ts` — read-only BullMQ depth + recent failures + the
  repeatable ticks. `worker-heartbeat.ts` — the worker upserts a
  `WorkerHeartbeat` row every ~15s; staleness ⇒ degraded/down. `admin-metrics.ts`
  / `admin-lists.ts` — the durable, DB-derived dashboard numbers (AI tokens /
  cost / latency from `AgentRun`, crawler failures from `Crawl`, job duration
  from `AutomationRun`, `pg_stat_*`) and the paged, secret-free entity lists.
  `apps/web/app/(admin)/admin/*` — 13 read-only sections behind
  `requirePlatformStaff()`. A correlation id is resolved per request in the
  observability layer (`withRouteObservability` / `getCorrelationId()`; not in
  middleware — wrapping `auth()` there drops the redirect `callbackUrl`); the
  worker moved to the shared pino factory. **No secrets in admin output** (pino redaction + `scrubSecrets` + explicit `select` with
  no token ciphers + Stripe-id masking + gated `/api/metrics`). Twelfth Prisma
  migration `20260916120000_admin_observability` (additive, non-tenant:
  `ErrorEvent`, `WorkerHeartbeat`). New deps `bullmq` + `ioredis` in
  `packages/services`; new optional env `METRICS_TOKEN`, `WORKER_HEALTH_PORT`.
  ADR-0028. See `docs/OBSERVABILITY.md`.
- **Security-hardening pass** ✅ (operator's "Phase 14"): a full audit —
  `docs/SECURITY-AUDIT.md` (0 Critical, 2 High, 3 Medium, 3 Low, 6
  Informational; **all Critical/High fixed**), ADR-0029. No features added.
  Fixes: (H-1) OAuth callbacks are now **session-bound** —
  `completeYouTubeConnect` / `completeTikTokConnect` take `actingUserId` and
  reject a `state` whose `userId` differs, before any token exchange; the
  callback routes resolve the session. (H-2) new
  `packages/services/src/security/rate-limit.ts` — a **fail-open** fixed-window
  Redis limiter on magic-link send, OAuth connect/callback, agent stream,
  `/api/health` and crawl-start. (M-1) a **Content-Security-Policy** in
  `next.config.mjs`. (M-2) new `packages/services/src/security/untrusted.ts`
  (`wrapUntrusted` + `UNTRUSTED_CONTENT_SYSTEM_CLAUSE`) applied to the content
  and SEO agents. (M-3) provider errors no longer carry a token-bearing body +
  broadened pino redaction. Plus `timingSafeEqual` on `/api/metrics`, numeric
  hostname rejection in `seo/ssrf.ts`. New `security` namespace exported from
  `@growth-agent/services`. Regression tests:
  `packages/services/src/security/*.test.ts`,
  `packages/services/src/integrations/oauth-csrf.test.ts`.
- **Full QA pass** ✅ (operator's "Phase 15"): `docs/QA.md` is the coverage map
  (area × layer × where it runs). No product code changed. Added three
  CI-Postgres **integration** suites that self-skip locally —
  `security/tenant-isolation.integration.test.ts`,
  `automation/idempotency.integration.test.ts` (real
  `@@unique` blocks a duplicate tick; concurrent `claimRun` → one row),
  `billing/webhook.integration.test.ts` (redelivered event id `deduped`;
  concurrent → one row) — and three **e2e** specs: `e2e/api.spec.ts` (HTTP
  contract: CSP + hardening headers, no CORS, `/api/health` shape + burst
  safety, `/api/metrics` auth, webhook 400/200/malformed, agent-stream never
  streams unauth, OAuth callback error params, NextAuth `csrf`/`providers`,
  share-token 404), `e2e/ui.spec.ts` (auth form + failure state, mobile
  no-overflow on every public page, 404 page), `e2e/authed.spec.ts`
  (authenticated browser flows — mints a NextAuth JWE cookie for a seeded user;
  dashboard, empty state, VIEWER-vs-OWNER UI gating, `/admin` staff access,
  `sessionVersion` revocation — gated by `E2E_AUTHED=1` + Postgres, runs in
  CI). `.github/workflows/ci.yml` e2e job now sets `E2E_AUTHED=1`. **N/A
  items:** password recovery (no passwords — magic link is the recovery path),
  Notifications (`Notification` model not implemented — SEO alerts open Tasks).
- **Production deployment prep** ✅ (operator's "Phase 16", **not deployed**):
  `Dockerfile.web` (Next.js standalone, non-root, `HEALTHCHECK /api/health`),
  `Dockerfile.worker` (Node + Playwright Chromium, runs from TS source via
  `tsx` — `apps/worker` `start` = `tsx src/main.ts`, `tsx` moved to deps),
  `.dockerignore`, `docker-compose.production.yml` (web + worker + Caddy
  auto-TLS + one-shot `migrate`; external managed Postgres/Redis/S3),
  `deploy/` (`Caddyfile`, `prometheus.yml`, `alerts.yml`,
  `backup/pg-backup.sh` + `pg-restore.sh`, `README.md`). `next.config.mjs`
  gains `outputFileTracingRoot` + Prisma-engine includes for standalone.
  **`scripts/check-env.mjs`** — zero-dep env validator: per-target
  (web/worker) + per-feature-group (all-or-nothing) checks with rule-only
  reason strings; reports `set`/`MISSING`/`invalid`, **never prints a secret
  value**; `--file` / `--json` / `--allow-insecure`; contract pinned by
  `scripts/check-env.test.mjs` (`pnpm test:scripts`, wired into CI). Full
  17-step runbook in `docs/DEPLOYMENT.md` (rewritten). ADR-0031.
- **Final production-readiness audit** ✅ (operator's "Phase 17"): independent
  launch review — `docs/PRODUCTION-READINESS.md` (**0 BLOCKER, 0 CRITICAL**,
  2 HIGH, 5 MEDIUM, 6 LOW) with the 8 deliverables (architecture summary,
  capabilities, limitations, third-party API limits, security/testing/deploy
  status, launch checklist). Full pipeline run: format/lint/typecheck clean,
  515 unit + 9 script tests pass, normal web build + worker typecheck green,
  migrations 0-drop additive, `prisma validate` OK. **Fixed:** H-1 — public
  `GET /r/[token]/export` re-rendered a PDF per request with no limit
  (CPU-amplification DoS); now per-IP `checkRateLimit` (30/min) + `private,
max-age=60` (immutable snapshot), and the authed `/app/reports/[id]/export`
  gets a per-org+user limit; M-1 — added `app/(admin)/admin/loading.tsx`.
  **Not fixed (documented + on the checklist):** H-2 — `nodemailer@8` has 6
  advisories (3 high) but `next-auth@5.0.0-beta.32` hard-pins `nodemailer@^7||^8`
  (bump when the peer relaxes; mitigations in place — no `raw`, validated
  single recipient, no allow-list reliance). `pnpm audit` also flags
  `deepmerge-ts<8` (Prisma-CLI build-time, no attacker input) and `ai<5.0.52`
  (unused file-upload feature — v5 is a breaking migration). ADR-0032.
- **Complete application audit** ✅ (operator's "Phase 18"): independent
  full-app audit (CTO / QA / security / DevOps / product), **audit-only — no
  features, no redesign, no unnecessary refactor**. `docs/FINAL-AUDIT.md` —
  13-section report + a 10-item final CTO report. **0 BLOCKER, 0 CRITICAL**;
  3 HIGH (SEC-1 `nodemailer` CVEs peer-locked to v8; FEAT-1 magic-link sign-in
  is **non-functional without an SMTP/Resend provider** — `EMAIL_TRANSPORT`
  defaults to `console`; COMP-1 no account/org deletion + no DSR export/delete
  flow — `org:delete` is a defined-but-unimplemented RBAC action), ~11 MEDIUM,
  ~9 LOW. Full pipeline green: format, lint 14/14, typecheck 14/14, unit
  515/515, env script 9/9, integration in CI, Playwright e2e 58 passed /
  5 infra-skipped, **web + worker builds exit 0**, `prisma validate`, migrations
  0-drop additive. **No code changed** beyond doc corrections: object storage,
  Sentry, Google Search Console, and the notification system are referenced in
  `.env.example` / the `IntegrationProvider` enum / docs but **not implemented**
  — the docs were softened to "planned"; client- and edge-runtime errors are
  captured nowhere (server errors do reach `ErrorEvent` / `/admin/errors`).
  Confirmed clean: 0 TODO/FIXME, 0 `any` in non-test, 0 `dangerouslySetInnerHTML`
  / `eval` / `child_process`, every route + Server Action auth-guarded,
  tenant-isolation integration-tested, crawler SSRF coverage comprehensive, no
  N+1. **Verdict: NOT production-ready for general availability; defensible for a
  closed / invite-only beta** once email sign-in and the container build work.
  GA critical path: verify the Docker + Next standalone build on a real Linux
  builder + a live `/api/health`; deploy monitoring/alerting; resolve or
  formally accept SEC-1; implement COMP-1 before an EU/CA GA (fix the
  `CrawlPage`/`CrawlLink` cascade — DB-3 — first); commission a penetration
  test. ADR-0033.
- **Forensic codebase audit** ✅ (operator's "Phase 18 — Forensic Codebase
  Audit"): evidence-only re-inspection, not trusting prior audit claims.
  `docs/FORENSIC-AUDIT.md` — feature matrix (IMPLEMENTED / PARTIAL / MISSING /
  BROKEN / EXT-CONFIG / EXT-APPROVAL), DB/API/frontend/test verification, and a
  10-section gap report (executive summary · feature matrix · missing · partial ·
  broken · external config · security · deployment blockers · technical debt ·
  remediation order). Fresh runs: lint 14/14 (0 warn), typecheck 14/14,
  `packages/services` 506 tests + 9 script tests pass. **Key findings:** object
  storage, Sentry, OpenTelemetry and Resend/Upstash are documented in
  `.env.example` / this file / `ARCHITECTURE.md` but have **zero implementing
  code** (MISSING, not partial); the notification system and Google Search
  Console are enum/doc-only; `apps/web/src/env.ts` (boot env validation) is
  imported by nothing (dead code); the Docker images have never been built (CI
  only syntax-lints them, `continue-on-error`); magic-link sign-in is inert
  without `EMAIL_TRANSPORT=smtp`; Postgres RLS is documented but unimplemented;
  `apps/web` + `apps/worker` have no unit tests. No BROKEN runtime functionality
  (one stray untracked empty migration dir; one misconfigured worker vitest
  glob). No code changed. See ADR-0034.
- **Production gap remediation** ✅ (operator's "Phase 19"): fixed every
  BLOCKER / CRITICAL / HIGH from `docs/FORENSIC-AUDIT.md`; report in
  `docs/REMEDIATION-REPORT.md`. **D-1** — CI now really builds both Docker
  images + boots `docker-compose.production.yml` and curls `/api/health`, and
  runs the Next `NEXT_OUTPUT_STANDALONE=1` build. **D-2** — real Resend HTTP
  transport for the magic link (`EMAIL_TRANSPORT=resend`, one API key, no SMTP
  infra); a prod config with no sign-in path fails `check-env.mjs` **and** boot.
  **D-3** — `packages/services/src/config/env.ts` (Zod, prod-strict) is imported
  for its side effect by the web root layout + the worker entry; the dead
  `apps/web/src/env.ts` is deleted. **M-1** — a real `Notification` model +
  service (non-throwing, dedupe-keyed) wired to report-ready/failed,
  crawl-finished/blocked, automation FAILING/DISABLED, and invitations; bell +
  `/app/notifications`; email fan-out when a transport exists (digests still
  out). **M-2 / D-8** — org soft-delete → grace → hourly worker purge (cascades;
  `CrawlPage`/`CrawlLink` FKs changed to `onDelete: Cascade` in migration
  `20260917120000`), user-account deletion + `sessionVersion` bump + sole-owner
  cascade + anonymising purge, and a JSON DSR export route; typed-confirm
  "Danger zone" in Settings. **D-4** — `/api/client-error` sink + `window`
  handlers + edge `onRequestError` fan-out (client/edge errors now reach
  `ErrorEvent`); `prometheus` + `alertmanager` services added to the prod
  compose behind a `monitoring` profile. **D-5 / S-2** — `scripts/audit-allow.mjs`
  - `.audit-allowlist.json` gate CI on any _new_ moderate+/high advisory.
    **M-9 / S-1 (RLS)** — deferred to its own phase (the assumed `withOrgScope`
    choke point is unused; a safe retrofit needs a real DB to verify); instead
    `scripts/check-tenant-scope.mjs` fails CI on an unscoped tenant query and the
    isolation integration tests stay the backstop. **B-1/B-2** — stray empty
    migration dir removed; `apps/worker/vitest.config.ts` added (+ a real
    processor test). Docs corrected: S3 / Sentry / OTEL / Upstash / GSC moved to a
    "NOT IMPLEMENTED" block. All gates green: lint 14/14, typecheck 14/14, unit
    514 services + others, web build (normal + standalone). Integration / e2e /
    Docker run in CI. See ADR-0035.
- **Google Search Console integration** ✅ (operator's "Phase 20"): real
  integration on Google's Search Console API v1 (`webmasters/v3` + URL
  Inspection). `packages/services/src/searchconsole/*` + `integrations/google.ts`
  (adds the `webmasters.readonly` + `openid` + `userinfo.email` scopes and a
  second `registerProviderOAuth('GOOGLE_SEARCH_CONSOLE')`). **Reuses the Google
  OAuth client + the `/api/integrations/google/callback` route**, now
  provider-aware via the signed `state.provider` — the YouTube branch is
  unchanged. OAuth + refresh (`withFreshAccessToken`) + health (`IntegrationHealth`)
  - disconnect (upstream revoke + token scrub); AES-256-GCM tokens, never sent to
    the browser. `SearchConsoleSite` (property discovery / selection /
    verification-status) + `SearchConsoleSnapshot` (`PERFORMANCE` / `SITEMAPS` /
    `URL_INSPECTION` captures — every displayed/reasoned figure is Google's own,
    never synthesised). Dashboard `/app/seo/search-console` (Queries · Pages ·
    Countries · Devices · Search appearance · Sitemaps · Indexing) + management
    page `/app/integrations/search-console`. **The AI SEO Agent** now combines
    crawler + Search Console evidence: `searchconsole/correlate.ts` computes three
    deterministic, source-labelled correlations (`crawlerEvidence` /
    `searchConsoleEvidence` / `interpretation`) — issue on an impression page,
    impressions but low CTR, sitemap page with weak internal linking — added to
    `SeoAgentReport.searchConsole`; the model's `searchConsoleNote` is
    grounding-checked against `gsc_*` fact ids and dropped if it can't be grounded.
    Six read-only `gsc.*` agent tools that return `{ available: false }` rather
    than invent. New `search-console-sync` BullMQ queue + processor. Twelfth-plus
    Prisma migration `20260918120000_search_console` (3 enums, 2 models, additive,
    0 `DROP`). Security: signed OAuth state + session-bind, tenant isolation on
    both models (+ `check-tenant-scope.mjs` + a cross-tenant integration test),
    `integration:manage` / `data:read` authz, per-user/IP/org rate limits, typed
    API errors. `webmasters.readonly` is not a Google "sensitive" scope — no
    extra Google audit, only a published consent screen. Resolves FORENSIC-AUDIT
    M-5 / INT-3. Gates green: lint 14/14, typecheck 14/14, **550 services unit
    tests** (+ ~44), web build. See `docs/GOOGLE-SEARCH-CONSOLE.md`, ADR-0036.
- **Production AI configuration** ✅ (operator's "Phase 22"): audit +
  productionization of the AI layer, no new product features. `packages/ai`
  gains `withResilience` (per-call `AI_REQUEST_TIMEOUT_MS` deadline via
  `AbortController` + one timeout retry + a per-call **kill switch** —
  `AI_DISABLED` / `AI_DISABLED_PROVIDERS` → `AiDisabledError`), `FallbackProvider`
  (`AI_FALLBACK_MODELS` = `"provider:model,…"` cross-provider chain, tried in
  order on any thrown error), and `modelForRole('analyst'|'router'|'long_context'
|'embedding')` from `AI_MODEL_<ROLE>` env. `createRegistryFromEnv` wraps every
  provider so all ~15 call sites gain timeout/retry/fallback/kill-switch
  unchanged; transient 429/5xx retry stays in the SDK (`AI_MAX_RETRIES`, not
  stacked). The analyst job factories resolve the `analyst` role. New
  `usage.enforceAiUserLimit` — a fail-open Redis **per-user** AI throttle
  (`AI_USER_RATE_LIMIT`/window) in front of the per-org `AI_REQUESTS`
  entitlement, wired into the agent-stream route + SEO-agent / content /
  monetization / YouTube / TikTok analyst actions. **Prompt-injection fencing is
  now on every model prompt**: `wrapUntrusted` + `UNTRUSTED_CONTENT_SYSTEM_CLAUSE`
  extended from content/SEO to the YouTube (`YOUTUBE_VIDEO_METADATA`), TikTok
  (`TIKTOK_VIDEO_METADATA`) and monetization (`MONETIZATION_SIGNALS`) analysts,
  the content generator (`CONTENT_ANALYSIS`), and the Growth Agent planner /
  orchestrator / memory extractor (`USER_MESSAGE`, `CHAT_HISTORY`,
  `CAPABILITY_EVIDENCE`); the grounding check stays the post-model second line.
  New adversarial suites: `packages/services/src/agents/adversarial.test.ts`
  (prompt injection, malicious website/content, fabricated analytics, conflicting
  data, missing data, invalid tool calls), `packages/ai/src/{resilient,fallback,
roles}.test.ts`, `packages/services/src/usage/ai-limit.test.ts`. Structured
  output (`generateObject(schema)` + grounding + deterministic fallback on every
  critical op), restricted tools (only `seo-agent` + `growth-agent` have a tool
  surface, both read-only; six analysts have no tool loop), and
  confirmation-before-consequential-action (ADR-0022) were **verified**, not
  changed. New optional env (`config/env.ts` + `.env.example`). Gates green:
  lint 14/14, typecheck 14/14, **`packages/ai` 22 tests**, **`packages/services`
  568 tests** (+16), web build. See `docs/AI-PRODUCTION-AUDIT.md`,
  `docs/AI-ARCHITECTURE.md`, ADR-0037.
- **Production billing** ✅ (operator's "Phase 23"): audit + gap-close of the
  subscription + metering system (no schema change, no new dependency). Verified
  unchanged: the 5-tier `PLAN_CATALOG` (FREE / CREATOR / PRO / AGENCY /
  ENTERPRISE — all 8 meter limits + 7 features per tier, ENTERPRISE unlimited);
  the signature-verified doubly-idempotent webhook (`BillingEvent` ledger id =
  Stripe event id + convergent id-keyed upserts; bad sig → 400, unknown → SKIPPED,
  handler throw → row FAILED + rethrow → Stripe redelivers → retried); server-side
  `billing:manage` (OWNER) on every Server Action; the browser only ever gets a
  Stripe-hosted URL. **Gaps closed:** new `usage.enforceAiBudget` enforces
  **both** `AI_REQUESTS` and `AI_TOKENS` before every model turn
  (`/api/agent/stream` + the YouTube / TikTok / monetization / SEO-agent Server
  Actions, which previously enforced neither); `AI_TOKENS` and a new
  `CRAWL_PAGES` pre-flight gate at `startCrawlAction` are **exhaustion gates**
  (block the next request once the budget is spent — a call's token/page count is
  unknowable up front, ADR-0038); `invoice.payment_failed` / `PAST_DUE` now write
  an org-wide `WARNING` `Notification` (idempotent on `dedupeKey`) and
  `invoice.payment_succeeded`/`paid` an `INFO` recovery notice, via the existing
  `createNotification`. New tests: `billing/lifecycle.test.ts` (signup → checkout
  → creation → upgrade → downgrade → cancel → resume → renewal → failed payment
  → recovery → deletion), `billing/expiration.test.ts` (entitled-status matrix +
  `resolvePeriod` calendar fallback + reconcile self-heal), `usage/enforcement.test.ts`
  (over-limit refused for all 7 metered resources), `usage/ai-budget.test.ts`,
  extended `billing/webhook.test.ts` (retry-safe + payment-failure notification)
  - `billing/plans.test.ts`. Gates green: lint 14/14, typecheck 14/14,
    **`packages/services` 605 tests** (+37), web build. See
    `docs/BILLING-PRODUCTION-AUDIT.md`, `docs/BILLING.md`, ADR-0038.
- **SEO crawler security audit** ✅ (operator's "Phase 24"): an **adversarial**
  audit that reproduced findings live against the running code, not just by
  reading it. **BLOCKER** — `seo/ssrf.ts` `isBlockedIp`'s embedded-IPv4-in-IPv6
  detector was a string regex on a dotted quad, but Node's `URL` parser
  canonicalizes `::ffff:127.0.0.1` to the hex-group form `::ffff:7f00:1` (the
  dotted quad is gone) — `http://[::ffff:169.254.169.254]/` (and 6to4/NAT64
  equivalents) reached cloud metadata unblocked; fixed by decoding the embedded
  v4 from the address's **numeric groups** instead of a string regex. **CRITICAL** —
  `robots.ts` / `url.ts` translated `*`-wildcard patterns (robots.txt
  Allow/Disallow, crawl include/exclude globs) into a **backtracking regex**; a
  ~40-char attacker-controlled robots.txt `Disallow` value hung the process
  indefinitely — confirmed live — freezing every concurrent crawl job sharing
  the worker's Node process (`concurrency: 4`); fixed with a new
  `seo/pattern-match.ts` linear (no-backtracking) wildcard matcher, replacing
  both call sites entirely. **CRITICAL** — the headless-render path
  (`apps/worker/src/seo/playwright-renderer.ts`) validated a subresource URL
  via `assertSafeUrl` in a `page.route` interceptor but let Chromium make the
  actual connection with its own unpinned DNS resolution — the exact
  resolve→connect DNS-rebinding TOCTOU `fetch.ts` already defeats by pinning;
  fixed with a new `seo/pinning-proxy.ts` local forward CONNECT/HTTP proxy
  (Node `http`/`net` only, no dependency) that every Playwright context is now
  routed through (`newContext({ proxy })`, a per-context Chromium option — the
  existing singleton browser is unchanged), pinning the real socket to the
  validated address; TLS is never terminated (CONNECT only splices bytes).
  **HIGH (fixed as a cheap bonus)** — `link-graph.ts`'s duplicate-content
  clustering was O(n²) in the common case (mostly-distinct pages); bucketed by
  simhash prefix. **HIGH (documented, not changed)** — the 200,000-page crawl
  ceiling is independent of the org's billing `CRAWL_PAGES` budget. Everything
  else in the brief's test list (localhost/private-IP/link-local/metadata/
  internal-hostname targets, alternative IP encodings, non-HTTP schemes,
  redirect-based SSRF, huge pages/headers, decompression bombs, large sitemaps,
  large URL counts, slow responses, connection exhaustion) was already
  correctly defended — confirmed by direct testing, not just inspection. New
  tests: `pattern-match.test.ts`, `pinning-proxy.test.ts`, extended
  `ssrf.test.ts`/`robots.test.ts`/`url.test.ts`/`fetch.test.ts`/
  `link-graph.test.ts`. Gates green: lint 14/14, typecheck 14/14,
  **`packages/services` 634 tests** (+29), worker typecheck + tests, web build.
  See `docs/CRAWLER-SECURITY-AUDIT.md`, `docs/SEO-ENGINE.md` §2,
  `docs/SECURITY.md` §7, ADR-0039.
- **AI red team** ✅ (operator's "Phase 25"): attacked the AI layer as a
  malicious user — prompt injection, secret exposure, unauthorized actions,
  cross-tenant access, tool manipulation, indirect injection via crawled/
  social content — reproducing each attack as a test against the real code
  before fixing anything. Most named attacks were already closed
  structurally (no model-driven tool-calling loop — every `seo.*`/`gsc.*`
  call is made by our own code before any prompt exists; org scoping comes
  from server-derived context, never the message or model output; no
  write/publish tool anywhere in the agent layer) and are now pinned by
  tests rather than new code. Three gaps got a fix: **(1)** the shared
  `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` (`packages/services/src/security/untrusted.ts`,
  already on every model-facing prompt) now states the SYSTEM/DEVELOPER >
  USER > EXTERNAL DATA trust hierarchy by name and forbids revealing the
  system prompt, claiming elevated authority, or complying with a
  publish/skip-approval request found in user text or external data —
  one-file change, reaches all ~11 prompts. **(2)** new
  `packages/services/src/agents/output-scrub.ts` (`scrubModelOutput`) deep-
  walks every agent's final output — model path and deterministic fallback
  alike — through the existing `scrubSecrets`, wired into all nine agents
  that produce model output plus the growth-agent orchestrator, catching a
  compromised response that echoes an API key / JWT / connection-string
  credential. **(3)** `agent/orchestrator.ts`'s new `finalizeBlocks` forces
  `requiresConfirmation: true` on every `proposedActions[]` entry with
  `kind: 'external'` unconditionally, closing the one field `checkGroundingFields`
  never examined — not exploitable today (nothing reads that flag to gate a
  real action yet) but no longer model-trusted either. New
  `packages/services/src/agents/ai-red-team.test.ts` (13 tests, companion to
  Phase 22's `adversarial.test.ts`) plus `output-scrub.test.ts` (5 tests).
  Gates green: lint 14/14, typecheck 14/14, **`packages/services` 654 tests**
  (+20), web build. See `docs/AI-SECURITY-AUDIT.md`, `docs/AI-ARCHITECTURE.md`
  §5/§7, `docs/SECURITY.md` §11, `docs/AGENTS.md`, ADR-0040.
- **Data accuracy validation** ✅ (operator's "Phase 26"): traced every
  displayed metric (Source → API field → DB field → Calculation → Display)
  across YouTube, TikTok, Search Console, the SEO crawler, revenue, and the
  reporting engine's growth-% math. Every derived-metrics function was
  already a correct pure computation; the eight defects found were all at
  the missing/zero/estimated boundary. **Fixed:** YouTube's `syncAnalytics`
  now throws `MalformedApiDataError` (marks the run FAILED, writes nothing)
  when a requested Analytics column is absent from an otherwise-successful
  response, instead of silently zero-filling it (`estimatedRevenue`'s
  already-correct absence-is-`null` handling is untouched); TikTok video
  sync skips (rather than fabricating a 1970-01-01 `createTime` for) a video
  missing `create_time`; the YouTube Performance page's dead "Net subs
  (28d)" stat (hardcoded `pct(null)`) is wired to the real value; Search
  Console's own aggregate CTR/position (Google's per-row values are
  untouched) are now `null`, not `0`, on zero impressions — Google never
  reports a real position of `0`; the Revenue tracker's copy no longer
  claims "nothing is estimated" beside a genuinely estimated recurring/mo
  figure. **A hand-verified test caught a live bug**: writing the first
  exact-value test for `recurringMonthlyByCurrency` failed against the real
  code — its "months spanned" calculation mixed UTC-parsed dates with
  local-time getters, corrupting the estimate on any server west of UTC
  (reproduced on this very machine); fixed to use UTC getters, matching the
  convention `byMonth` already used two lines above in the same function.
  New `tiktok/metrics.test.ts` (zero coverage existed), `youtube/sync.test.ts`,
  `tiktok/sync.test.ts`, plus hand-computed exact cases added to
  `scoring.test.ts`, `youtube/metrics.test.ts`, `reports/sections.test.ts`,
  `monetization/revenue.test.ts`, `searchconsole/read.test.ts`. Gates green:
  lint 14/14, typecheck 14/14, **`packages/services` 671 tests** (+17), web
  build. See `docs/DATA-ACCURACY.md`, ADR-0041.
- **Full E2E testing** ✅ (operator's "Phase 27"): a complete Playwright
  journey (landing → signup → onboarding → dashboard → connect YouTube/
  TikTok/Search Console → add website → crawl → issues → AI agent → content
  → recommendation → task → report → billing → change plan → logout), plus
  failure-injection and security tests, on `apps/web/e2e/{journey,failures,
security}.spec.ts` (new) alongside the existing Phase 15 suite. Running the
  existing suite exactly as CI configures it (before writing anything new)
  found a real, previously undetected bug: `GET /api/health` returned **500**,
  not 200, under the e2e/CI boot (`NODE_ENV=production`, a `localhost`
  `NEXT_PUBLIC_APP_URL`, no `AUTH_URL`/`ENCRYPTION_KEY`/sign-in path) —
  `config/env.ts`'s prod-strict boot validation (Phase 19) throws at
  **module-import time**, and the services barrel's eager re-export means the
  first route touching `@growth-agent/services` (`/api/health`, for its
  DB/Redis checks) poisons that module for the whole process. **Fixed:**
  wired the existing (previously unused) `GROWTH_AGENT_ENV_STRICT=0` escape
  hatch into `playwright.config.ts`'s `webServer.env` (CI inherits it
  automatically); `/api/health`'s own imports are now loaded dynamically
  inside a `try` (mirroring `instrumentation.ts`'s existing pattern) so a
  config failure is one more `checks[]` entry in the normal 200 body,
  restoring Phase 13's "always 200" contract independent of strict mode.
  New `e2e/support/seed.ts` factors `authed.spec.ts`'s session-cookie-minting
  convention into shared seed helpers (verified website, crawl + issues, a
  "connected" OAuth row, a monetization opportunity); real Google/TikTok/
  Stripe consent screens are never automated (no live credentials, provider
  policy) — "Connect" is verified to reach the real authorize host and the
  connected/paid state is seeded directly, the same honesty convention
  `docs/QA.md` already used for its N/A entries. **Verification limit,
  disclosed not hidden:** this machine's Docker Desktop cannot start —
  `wsl --install` fails with `HCS_E_HYPERV_NOT_INSTALLED`, i.e. virtualization
  is off in firmware, fixable only by a physical BIOS restart. Confirmed
  instead: format/lint/typecheck clean 14/14, `packages/services` 671 tests
  unaffected, web build clean, and a full `pnpm --filter @growth-agent/web
test:e2e` run with **61/88 tests passing** (every non-DB-dependent test,
  including the `/api/health` fix) and the remaining 27 (DB-gated) skipping
  cleanly rather than erroring — confirming the new specs are structurally
  sound but not yet verified end-to-end against a real Postgres. See
  `docs/E2E-TESTING.md`, `docs/QA.md`, ADR-0042.
- **Performance and load testing** ✅ (operator's "Phase 28"): measured
  frontend/API/DB/Redis/AI/crawler/background-job performance and optimized
  what a redundant-work audit found, without a live Postgres/Redis (same
  firmware-level virtualization block as Phase 27, re-confirmed). Combined
  real `autocannon` load tests (transient `npx`, never a dependency) against
  every endpoint reachable without a database, one bug reproduced live, and
  an architectural capacity analysis for the rest — every number in
  `docs/PERFORMANCE-REPORT.md` labeled measured or projected. **Found and
  fixed live**: `GET /api/health` stalled ~4s with the DB unreachable —
  three of its five checks (`checkDatabase`, `checkExternalIntegrations`,
  `checkWorker`, `packages/services/src/observability/health.ts`) had no
  explicit timeout, so `Promise.all` didn't protect against the Prisma
  driver serializing its own connection attempts; now bounded via the same
  `Promise.race` pattern `pingRedis` already used, confirmed live at ~2.7s
  bounded vs. the prior recurring ~4s stall. **Also fixed:** the Growth
  Agent orchestrator's up-to-5 capability calls and content-generation's
  up-to-13 per-type calls (`agent/orchestrator.ts`, `content/generate.ts`)
  now run concurrently instead of serially, per-item error isolation
  preserved; a duplicate `Subscription` query in `usage/check.ts` +
  `usage/summary.ts` removed by widening `resolveEntitlements`'s existing
  read (`billing/entitlements.ts`); the crawler `finalize()`'s two N+1
  write loops (`seo/crawler.ts`) extracted into exported functions using
  the existing `ConcurrencyLimiter` at bounded concurrency, with new
  `seo/crawler.test.ts` (this code had zero fast test coverage before);
  three oversized `select`/`include`s narrowed (`content/read.ts`,
  `agent/orchestrator.ts`'s history fetch, `youtube/read.ts`);
  `requireUser`/`requireActiveOrg` (`apps/web/src/lib/auth.ts`) memoized
  per-request via React's `cache()` (Phase 13 precedent); a
  `Recommendation` index gap closed with a hand-authored migration
  (`@@index([organizationId, priorityScore, createdAt])`), reviewed by eye
  against every existing migration's identical `CREATE INDEX` pattern
  since there's no live DB to run `prisma migrate dev` against.
  **Documented, not fixed** (rationale in the report): BullMQ per-queue
  concurrency tuning, a caching layer, additional speculative indexes, and
  horizontal scaling — none justified without live telemetry this
  environment can't produce. Gates green: format/lint/typecheck 14/14,
  **`packages/services` 681 tests** (+10), script/tenant-scope/audit-allow
  gates, web build. See `docs/PERFORMANCE-REPORT.md`, ADR-0043.
- **UI/UX accessibility audit** ✅ (operator's "Phase 29"): audited
  desktop/tablet/mobile navigation, forms, tables, dialogs, loading/empty/
  error states, keyboard/ARIA/contrast/reduced-motion, and resilience
  under missing data/API failure/thousands of records/slow AI/an
  in-progress crawl — **no redesign, fix what's necessary**. Three
  research passes plus hand-computed contrast ratios found a bounded set
  of real gaps. **Fixed:** light-mode `--muted-foreground` darkened
  (~4.70:1 → ~6.1:1, was right at the WCAG AA edge); a
  `prefers-reduced-motion` guard added (`packages/ui/src/styles.css`,
  previously zero occurrences repo-wide), using the standard near-zero
  -duration pattern so Radix's `Presence` unmount logic still fires
  correctly; `CardTitle` now renders `<h3>` app-wide (153 call sites, pure
  `className`-driven styling so zero visual change, confirmed live) with
  `Badge` moved to `<span>` for valid heading nesting; `Skeleton` is now
  `aria-hidden` with one `role="status"` wrapper per loading view instead
  of one announcement per bone; every transient form/Server-Action result
  across the app (previously **zero** `role="alert"`/`aria-live`/
  `aria-invalid` anywhere in `apps/web`, confirmed by two independent
  greps) now announces to screen readers — deliberately scoped to
  just-performed-action results, not the ~55 sites that were static
  persisted data display; the crawl issues list's hard 100-item cap (no
  way to reach the rest of a large crawl) replaced with cursor pagination
  matching the existing YouTube/TikTok "Load more" pattern, plus an exact
  total count (`seo/read.ts`'s `listCrawlIssues`); table `<th>`s gained
  `scope="col"`; a few smaller fixes (an unlabeled settings `<select>`,
  `EmptyState`/notification-bell ARIA, `(auth)`/`onboarding` `loading.tsx`
  files that didn't exist before, empty-state consistency). **Documented,
  not fixed:** a toast system, new Select/Checkbox/Tooltip primitives,
  live crawl-status polling, an agent-chat cancel button/stall-timeout —
  each judged a new feature rather than a fix, or unverifiable without
  live infrastructure this environment lacks. Gates green:
  format/lint/typecheck 14/14, `packages/services` 681 tests (unchanged),
  a DB-less e2e run matching Phase 27's 61/88 baseline exactly, web build.
  **Same verification limit as Phases 27-28**: authenticated surfaces
  verified by type-checking + the DB-less e2e suite, not a live click
  -through — no Docker/WSL available. See `docs/ACCESSIBILITY-AUDIT.md`,
  ADR-0044.
- **Staging deployment** ⚠️ (operator's "Phase 30", **runbook only — no
  staging environment is actually operational**): this session has no cloud
  account, no domain, and no Google/TikTok/Stripe/email-provider
  credentials — confirmed no cloud CLI is installed and no such credentials
  exist in the environment — so nothing here could be deployed for real;
  asked, the user chose a runbook-only path over handing over live
  infrastructure access. Delivered: `docs/STAGING.md` (a complete,
  staging-flavored walkthrough of `docs/DEPLOYMENT.md`'s production process
  — domain/DNS, Supabase Postgres, Upstash Redis, an optional AI provider
  key, a Google OAuth client serving YouTube + Search Console + "Sign in
  with Google," a sandbox TikTok app, **Stripe TEST mode only** with a
  mechanical `sk_live_`/`pk_live_` grep check, email via Resend or console,
  migrations, starting web/worker, and a concrete verification checklist for
  `/api/health`, background jobs, OAuth callbacks, webhooks, the crawler,
  AI, and billing); `docker-compose.staging.yml` (a deliberate, separate
  near-duplicate of `docker-compose.production.yml` — Compose's `env_file:`
  path is a literal string, so reusing the production file would need a
  file literally named `.env.production` holding staging secrets on the
  staging host, a real foot-gun; the new file's header comment enumerates
  its exact, exhaustive diff from production); `.env.staging.example`
  (mirrors `.env.example`, annotated for Supabase/Upstash/test-mode
  specifics; validated by filling it with well-formed placeholder values and
  running `node scripts/check-env.mjs` against it — `✓ ready`, confirming
  every variable name and rule matches the real validator). Object storage
  is explicitly **not** configured as an app feature — no code reads `S3_*`
  today (`.env.example`, `docs/FORENSIC-AUDIT.md`), so the runbook says so
  rather than inventing configuration for a nonexistent feature, and points
  the one real use of object storage on staging (the already-implemented
  Postgres backup script, a separate `BACKUP_S3_*` variable set) at
  Supabase Storage or R2 instead. Staging deliberately still runs
  `NODE_ENV=production` and the full strict env-validation path (no
  `--allow-insecure`, no `GROWTH_AGENT_ENV_STRICT=0`) — relaxing either
  would defeat the point of rehearsing production's actual boot behavior.
  No application code changed; format/lint/typecheck stayed fully cached.
  See `docs/STAGING.md`, ADR-0045.
- **Final security review** ✅ (operator's "Phase 31") — **Verdict: GO. No
  BLOCKER/CRITICAL found; two HIGH findings fixed.** A consolidation +
  fresh-eyes pass over the five prior security audits (Phases 14, 18, 24,
  25, plus billing/AI production audits), re-verifying every claim against
  current code and hunting for regressions from the five non-security
  phases since (26-30) — none found. Ran or attempted every requested tool:
  `pnpm audit --prod` clean (6 pre-existing allowlisted advisories); the
  full scan surfaced 1 critical + 1 high + 5 moderate, all in
  vitest/vite/esbuild devDependencies with zero production exposure and
  requiring `vitest --ui` (never invoked anywhere in this repo) —
  documented, not fixed (a major toolchain bump, out of proportion here).
  `detect-secrets`/Semgrep/Trivy could not run in this Windows/no-Docker
  sandbox (disclosed); substituted a targeted `git grep` secret scan
  (clean), manual SAST-style code review, and a live DAST-style pass
  against the built app (all headers/CORS/CSP confirmed correct). Crawler
  -SSRF (75), AI red-team (34), and `security` (11) test suites re-run
  clean, matching Phases 24/25 exactly. **Found and fixed two real HIGH
  bugs no prior audit caught:** `deploy/backup/pg-backup.sh` could upload
  an unencrypted database dump (contradicting `docs/SECURITY.md`'s own
  claim) — `BACKUP_GPG_RECIPIENT` is now hard-required;
  `regenerateAssetAction` (`apps/web/src/server/content-actions.ts`) made
  real AI calls with **zero** metering — no per-user throttle, no org
  quota check, no usage record — a direct violation of the master
  instruction's metering hard rule; fixed by copying its sibling action's
  exact three-call pattern. **Five MEDIUM fixes**: backup pruning was
  silently broken for the MinIO path; `REDIS_URL` didn't have to be TLS in
  production (`config/env.ts` + `check-env.mjs` both now require
  `rediss://` when strict); a new "Disaster Recovery" section
  (`docs/DEPLOYMENT.md` §18) names the single-host SPOF as an accepted
  risk for the first time and gives an honest RTO/RPO from the actual
  backup cadence; `docs/DEPLOYMENT.md` §3 previously described object
  storage as an app feature to provision — corrected to match the
  already-documented "not implemented" reality elsewhere, with real
  least-privilege guidance for the one thing that IS real (the backups
  bucket); a new `webhook_signature_failures_total` metric + Prometheus
  alert closes a monitoring blind spot, **verified live end-to-end** (a
  deliberately bad-signature webhook → 400 → the counter appears at
  `/api/metrics` immediately after). Gates green: format/lint/typecheck
  14/14, `packages/services` 681 tests (unchanged), web build. See
  `docs/FINAL-SECURITY-REPORT.md`, ADR-0046.
- **Still outstanding:** roadmap "Phase 3" (auth & tenancy hardening — **Postgres
  RLS (ADR-0035)**, the
  full edge/IP rate-limit layer + aggregate magic-link cap, a strict nonce-based
  CSP, invitation email; a tier-enforcement edge layer belongs here);
  roadmap "Phase 10" leftovers (recommendation lifecycle UI, task board,
  notifications + digests, dashboard aggregation); the general model-driven
  orchestrator + `generateWithTools` + `AgentToolCall` + `pgvector` memory +
  the remaining agents + agent kill switches; SEO object-storage archiving +
  network-isolated egress pool; billing follow-ups (a worker queue for the
  reconcile + counter rollup, Stripe usage-record push for metered overage);
  reporting follow-ups (charts in the PDF, scheduled report packs); automation
  follow-ups (timezone-aware schedules, a real notification channel);
  observability follow-ups (OpenTelemetry tracing spans, pushed threshold
  alerts, abuse-monitoring events + suspend, admin write actions). Do not
  start any of them without an explicit instruction.

### Running it locally

```bash
docker compose up -d
cp .env.example .env            # defaults match docker-compose
pnpm install
pnpm db:generate && pnpm --filter @growth-agent/db migrate:deploy
pnpm --filter @growth-agent/db seed   # owner@example.com / member@example.com
pnpm dev                        # http://localhost:3000  (magic-link prints to the console)
```

For the **AI Growth Agent** (`/app/agent`): no extra config. It runs fully
deterministically without an AI key (keyword planning + capability results +
assembled reply); set `ANTHROPIC_API_KEY` (or another provider) to enable
model planning, grounded synthesis, and a streamed natural-language reply.

For **Billing** (`/app/billing`): no config needed to develop — with no
`STRIPE_*` env the app runs everyone on the FREE plan and still enforces its
limits (`/app/billing` shows a "not configured" banner). To exercise real
flows set `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` and the
`STRIPE_PRICE_<TIER>_<MONTH|YEAR>` ids, and point a Stripe webhook (or
`stripe listen --forward-to localhost:3000/api/billing/webhook`) at the
endpoint. See `docs/BILLING.md`.

For **YouTube**: set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` /
`ENCRYPTION_KEY` (+ an AI key for the analyst), register the redirect URI
`http://localhost:3000/api/integrations/google/callback`, then connect from
`/app/integrations/youtube`.

For **TikTok**: set `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` /
`ENCRYPTION_KEY`, register `http://localhost:3000/api/integrations/tiktok/callback`
in the TikTok developer portal, then connect from `/app/integrations/tiktok`.
Publishing needs the `video.publish` scope (opt-in) and an audited TikTok app
for non-private posts.

For **SEO**: no third-party credentials needed to crawl. Add a website at
`/app/seo`, publish the DNS TXT record or the `/.well-known/growth-agent-verify.txt`
file it shows, click "Check verification", then "Start crawl". An AI key enables
the "Generate AI summary" button. `CRAWLER_HALT=1` (or
`CRAWLER_HALT_ORG_IDS=<id,...>`) stops all/those crawls. Headless rendering
(`renderMode` AUTO/HEADLESS) only runs through the `seo-crawl` worker queue,
which needs Playwright's Chromium installed (`pnpm --filter @growth-agent/worker
exec playwright install chromium`).
