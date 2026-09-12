# ARCHITECTURE.md

How Growth Agent is structured, why, and where each responsibility lives.
Companion docs: `DATABASE.md`, `API.md`, `AI-ARCHITECTURE.md`, `SECURITY.md`,
`SEO-ENGINE.md`, `DEPLOYMENT.md`.

---

## 1. Tech stack (final)

| Concern           | Choice                                                                                      | Notes                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Language          | **TypeScript** (strict, `noUncheckedIndexedAccess`, no `any`)                               | One language across web, worker, packages                                                                                                |
| Frontend          | **Next.js 15** (App Router) + **React 19**                                                  | RSC by default; client components where interaction requires                                                                             |
| Styling           | **Tailwind CSS**                                                                            | Design tokens as CSS variables (light/dark)                                                                                              |
| Components        | **Radix UI primitives** + local **shadcn/ui-style** wrappers in `packages/ui`               | Accessible (WAI-ARIA) foundation, no heavyweight component lib                                                                           |
| Server/API        | **Next.js Route Handlers + Server Actions** for the app; **dedicated Node worker** for jobs | No separate HTTP framework — justified in `DECISIONS.md` (ADR-0006)                                                                      |
| Database          | **PostgreSQL 16**                                                                           | Single primary; read replica optional later                                                                                              |
| ORM               | **Prisma 6**                                                                                | Typed client, checked-in migrations, `directUrl` for migrate                                                                             |
| Auth              | **Auth.js (NextAuth v5)** + Prisma adapter, **JWT sessions** (ADR-0011)                     | Email magic-link + Google OAuth; edge-verifiable JWT + `sessionVersion` revocation; WorkOS is the enterprise-SSO upgrade path (ADR-0007) |
| Background jobs   | **BullMQ** on **Redis**                                                                     | Separate `apps/worker` process; queues per domain                                                                                        |
| Caching           | **Redis** (logical DB 1)                                                                    | Response/computation cache, rate-limit counters, crawl-dedup sets, idempotency keys                                                      |
| Object storage    | **S3-compatible** (AWS S3 / Cloudflare R2; **MinIO** locally)                               | Reports, exports, crawl artifacts, uploads — presigned URLs only                                                                         |
| AI                | **`packages/ai`** abstraction over the **Vercel AI SDK**                                    | Anthropic default; OpenAI + Google registered; see `AI-ARCHITECTURE.md`                                                                  |
| Logging           | **pino** (JSON)                                                                             | Request/job correlation ids                                                                                                              |
| Error tracking    | **Sentry** (web + worker)                                                                   | Release + source maps in deploy step                                                                                                     |
| Tracing / metrics | **OpenTelemetry** SDK → OTLP collector; `/metrics` (Prometheus text)                        | Spans for HTTP, DB, queue, external API, model calls                                                                                     |
| Health            | `/api/health` (web), `/healthz` + heartbeat (worker)                                        | Liveness + readiness (DB/Redis pings)                                                                                                    |
| Testing           | **Vitest** (unit + integration), **Playwright** (e2e)                                       | See `TESTING.md`                                                                                                                         |
| Packaging         | **Docker** multi-stage images (`web`, `worker`); **docker-compose** for local               | See `DEPLOYMENT.md`                                                                                                                      |
| CI                | GitHub Actions: format → lint → typecheck → unit → integration → e2e → security audit       | `.github/workflows/ci.yml`                                                                                                               |

Rejected alternatives and full rationale: `DECISIONS.md`.

---

## 2. Repository layout (target)

```
apps/
  web/            Next.js app — public site, authenticated app, admin, API routes, Server Actions
  worker/         BullMQ worker — job processors, schedulers, heartbeats
packages/
  core/           Domain types, Zod schemas, Result, agent + orchestration contracts (no I/O)
  db/             Prisma schema, generated client, migrations, seed, repository helpers
  ai/             Provider-agnostic AI layer: interface, registry, providers, pricing, usage
  services/       Business logic per module (auth, org, billing, seo, youtube, tiktok, content,
                  recommendations, reports, notifications, tasks, integrations, audit, usage).
                  Pure-ish: depends on db + ai + core, not on Next.js.
  ui/             Radix-based accessible component system + Tailwind preset (`./tailwind-preset`)
  observability/  pino logger factory + request-correlation helpers (OTel/metrics later)
docs/             This folder
```

Shared tsconfig/eslint presets live at the repo root; a dedicated
`packages/config` was deferred and its Tailwind preset folded into
`packages/ui` (ADR-0012). Workspace packages use `.js` import specifiers that
resolve to `.ts` source — `apps/web/next.config.mjs` remaps them for
webpack/Turbopack.

**Dependency rule:** `apps/*` → `packages/services` → (`packages/db`,
`packages/ai`, `packages/core`). `apps/web` and `apps/worker` never import each
other. `packages/core` has no runtime I/O. This lets both the HTTP layer and the
worker call the exact same service functions.

> Shipped so far: Phase 0 — `core`, `ai`, `db`, `web`, `worker`. Phase 2 —
> `ui`, `observability`, `services` (with the `auth`, `rbac`, `organizations`,
> `users`, `audit` modules). Remaining `services` modules (`billing`, `usage`,
> `integrations`, `youtube`, `tiktok`, `seo`, `crawler`, `content`,
> `recommendations`, `reports`, `tasks`, `notifications`) land in their phases
> (`ROADMAP.md`).

---

## 3. Application modules

Each module = a folder in `packages/services/<module>` exposing a typed API,
plus its slice of the Prisma schema, its routes/actions in `apps/web`, and its
job processors in `apps/worker`.

| Module              | Responsibility                                                                          | Owns tables (see `DATABASE.md`)                                             | Jobs                                   |
| ------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| **auth**            | Sessions, sign-in/out, magic links, OAuth login, CSRF, password-less flows              | `User`, `Account`, `Session`, `VerificationToken`                           | cleanup expired sessions               |
| **organizations**   | Tenants, membership, roles, invitations, org switching                                  | `Organization`, `Membership`, `Invitation`                                  | —                                      |
| **users**           | Profile, preferences, notification settings, data-export/delete requests                | `UserProfile`, `UserPreference`                                             | account deletion                       |
| **billing**         | Stripe customer/subscription, tiers, entitlements, checkout, portal, webhooks, invoices | `Subscription`, `Invoice`, `Price`, `Entitlement`                           | reconcile subscriptions                |
| **usage**           | Metering, limit checks, overage, per-org counters                                       | `UsageRecord`, `UsageCounter`, `UsageLimitOverride`                         | roll up counters, month reset          |
| **ai**              | Orchestrator, agents, tool registry, conversations, model calls, cost tracking          | `AIConversation`, `AIMessage`, `AgentRun`, `AgentToolCall`, `AiUsageRecord` | run agent tasks                        |
| **integrations**    | OAuth connect/callback/disconnect, token encryption + refresh, provider health          | `OAuthConnection`, `IntegrationHealth`                                      | token refresh, health poll             |
| **youtube**         | Data API v3 + Analytics API v2 clients, sync, snapshots, analysis inputs                | `YouTubeChannel`, `YouTubeVideo`, `YouTubeMetric`                           | channel sync, video sync, metrics sync |
| **tiktok**          | Display API client, sync, snapshots (scopes permitting)                                 | `TikTokAccount`, `TikTokVideo`, `TikTokMetric`                              | account sync, video sync               |
| **seo**             | SEO projects, website ownership verification, audit rules, issue lifecycle              | `SEOProject`, `Website`, `SEORecommendation`                                | schedule audit                         |
| **crawler**         | Bounded, SSRF-safe crawl engine: fetch, render, extract, normalize, link graph          | `Crawl`, `CrawlPage`, `CrawlIssue`                                          | run crawl, render page, post-process   |
| **content**         | Content ideas, gap analysis, repurposing suggestions                                    | `ContentIdea`                                                               | generate ideas                         |
| **recommendations** | Normalize findings → `Recommendation`, approval state, promotion to tasks               | `Recommendation`                                                            | —                                      |
| **reports**         | Compose + render reports (PDF/CSV/JSON), store, share                                   | `Report`                                                                    | render report                          |
| **tasks**           | Work items from recommendations, status, assignment                                     | `Task`                                                                      | due reminders                          |
| **notifications**   | In-app + email delivery, preferences, digests                                           | `Notification`                                                              | send email, build digest               |
| **admin**           | Platform-staff console + read models over all of the above                              | (reads) `PlatformStaff`                                                     | —                                      |
| **audit**           | Append-only security/action log, query API for admin                                    | `AuditLog`                                                                  | archive/rotate                         |

Cross-cutting: **observability** (logging/tracing/metrics) and **config/env**
are libraries, not modules.

---

## 4. Runtime topology

```
                   ┌─────────────────────────────────────────────┐
   Browser ──────► │ apps/web (Next.js)                           │
   (RSC/JSON)      │  • public site  • app  • /admin              │
                   │  • Route Handlers + Server Actions           │
                   │  • calls packages/services                   │
                   └───────┬───────────────┬─────────────┬────────┘
                           │               │             │
                   ┌───────▼──────┐ ┌──────▼──────┐ ┌────▼─────────┐
                   │ PostgreSQL   │ │ Redis        │ │ S3-compatible│
                   │ (Prisma)     │ │ queues+cache │ │ object store │
                   └───────▲──────┘ └──────▲──────┘ └────▲─────────┘
                           │               │            │
                   ┌───────┴───────────────┴────────────┴────────┐
                   │ apps/worker (BullMQ)                         │
                   │  • crawl / render (isolated egress)          │
                   │  • youtube / tiktok sync                     │
                   │  • agent runs  • reports  • emails           │
                   │  • schedulers (cron) + heartbeat             │
                   └───────┬─────────────────────────────────────┘
                           │ outbound (allow-listed)
                   ┌───────▼───────┐  ┌──────────────┐  ┌───────────────┐
                   │ Model providers│  │ Google/YouTube│  │ TikTok / GSC  │
                   │ (Anthropic…)   │  │ APIs          │  │ APIs / Stripe │
                   └────────────────┘  └──────────────┘  └───────────────┘
```

- **Web** is stateless and horizontally scalable. No long work inline — it
  enqueues and returns a job id.
- **Worker** scales per-queue by concurrency. The **crawl/render** processors
  run with restricted, allow-listed network egress (ideally a separate worker
  pool / network policy) so a crawl target can't reach internal services.
- **Schedulers** are BullMQ repeatable jobs owned by the worker. The
  **automation engine** (operator's "Phase 12", `docs/AUTOMATION.md`,
  ADR-0027) is the main one: user-defined `AutomationRule` rows carry the
  schedule, and a repeatable "sweep" (60s) + "retry-sweep" (30s) on the
  `automation` queue claim an idempotent `AutomationRun` per due tick and
  execute it under the rule owner's permissions. Token refresh, usage rollup
  and digest build follow the same repeatable-job pattern.

---

## 5. Request lifecycle (authenticated app)

1. Edge middleware verifies the signed session JWT (no I/O) and enforces route
   protection for `/app/**`, `/admin/**`, `/onboarding` via the `authorized`
   callback. Unauthenticated → redirect to `/login?callbackUrl=…`. The `/app`
   server layout then does the authoritative check (session revocation via
   `User.sessionVersion`, active org resolution).
2. The active **organization** is resolved from the session + membership (never
   from request body). Missing/invalid → 403.
3. Route handler / Server Action validates input with a **Zod** schema.
4. It calls a **service** function with `{ actor, org, input }`.
5. Service runs `authorize(actor, org, action)` (RBAC) and, for metered
   operations, `usage.check(org, meter, amount)`.
6. Service does the work via `packages/db` repositories (always
   `organizationId`-scoped) and/or enqueues a job.
7. Side-effectful/external-mutating actions create an **approval** record unless
   automation mode is enabled; audit entry written.
8. Response validated on the way out; errors mapped to the standard envelope
   (`API.md`).

---

## 6. Tenant isolation

- Every tenant-owned row carries `organizationId` (FK, `onDelete: Cascade`).
- All reads/writes go through repository helpers that **require** an
  `organizationId` argument; a lint rule + code review forbid raw
  `prisma.<model>` calls outside `packages/db`.
- Postgres **Row-Level Security** policies are added as defense-in-depth
  (`app.current_org` set per transaction) once the schema stabilizes.
- CI has isolation tests: user A of org 1 cannot read/write any org 2 resource
  across every module's public API.
- Admin uses a distinct authorization path (`PlatformStaff`), not org roles,
  and its reads are explicitly cross-tenant and audit-logged.

---

## 7. Configuration & secrets

- All config via environment variables; validated at boot with Zod
  (`apps/web/src/env.ts`, mirrored for the worker). Boot fails on missing/invalid.
- Only `NEXT_PUBLIC_*` is exposed to the browser.
- Secrets (DB creds, `AUTH_SECRET`, `ENCRYPTION_KEY`, provider keys, Stripe
  keys) come from the platform secret store. Never logged. See `SECURITY.md`.

---

## 8. Environments

| Env           | Purpose                                        | Data                                 |
| ------------- | ---------------------------------------------- | ------------------------------------ |
| `development` | Local; docker-compose Postgres + Redis + MinIO | Seed data, clearly marked dev-only   |
| `preview`     | Per-PR ephemeral deploy                        | Disposable DB, no real customer data |
| `staging`     | Pre-prod mirror                                | Synthetic + opt-in internal accounts |
| `production`  | Live                                           | Real, encrypted, backed up           |

---

## 9. Observability

Shipped in the operator's **Phase 13** (ADR-0028). Full detail in
`OBSERVABILITY.md`; the internal admin console is `/admin` (platform staff only).

- **Logs:** pino JSON via `@growth-agent/observability` `createLogger`, one line
  per request / job, with `correlationId`, `orgId`, `actorId`, latency,
  outcome. Key-path redaction (auth headers, cookies, `*.token`, `*.*Secret`,
  `*.*Cipher`, …). The worker uses the same factory.
- **Correlation ids:** resolved per request in the observability layer
  (`withRouteObservability`, `getCorrelationId()`) — a well-formed inbound
  `x-correlation-id` from a trusted proxy is kept, otherwise minted — and
  threaded into jobs via `job.data.correlationId`.
- **Metrics:** a hand-rolled in-process registry (`observability/metrics.ts`) —
  request latency + error rate, external-API failures, AI call latency, per-queue
  job duration, usage-limit rejections — rendered as Prometheus text at
  `GET /api/metrics` (web) and `:$WORKER_HEALTH_PORT/metrics` (worker). It is
  per-instance and resets on deploy; a scraper turns it into history. The
  durable dashboard numbers (AI tokens / cost / latency, crawler failures, job
  duration, DB performance) are computed from `AgentRun` / `Crawl` /
  `AutomationRun` / `pg_stat_*`. OpenTelemetry spans are still deferred.
- **Errors:** `observability.captureError` folds repeated faults into one
  de-duplicated `ErrorEvent` row (secret-scrubbed); wired into Next's
  `onRequestError` hook, the route wrapper, and the worker's job wrapper.
- **Health:** `GET /api/health` (web; always 200, body `status` reflects
  database + Redis + AI provider + external integrations + worker heartbeat).
  The worker serves `GET /healthz` + `/metrics` on `WORKER_HEALTH_PORT` and
  refreshes a `WorkerHeartbeat` row every ~15s. Thresholds (heartbeat
  staleness, error-rate, cost) are surfaced on `/admin/system-health`; pushing
  alerts to a channel is not yet built.

---

## 10. Failure & resilience

- External API calls: timeouts, capped retries with jittered backoff, circuit
  breaker per provider, results cached so a provider outage degrades rather
  than breaks.
- Jobs: idempotent processors keyed by a natural id; poison messages → dead
  letter queue + alert; bounded retries, no infinite retry loops.
- DB: migrations forward-only and backward-compatible for one release
  (expand/contract). Automated backups + tested restore.
- Errors are never silently swallowed — they are returned as typed `Result`
  errors or thrown, logged, and surfaced.
