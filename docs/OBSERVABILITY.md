# OBSERVABILITY.md

Internal administration (`/admin`) and operational observability. Shipped in the
operator's **Phase 13**. See `ARCHITECTURE.md` §9 for where this sits in the
system and `DECISIONS.md` ADR-0028 for the "why".

---

## 1. Shape

Everything lives in **`packages/services/src/observability/`** so the web app
and the worker share one implementation:

| File                  | Responsibility                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `queue-names.ts`      | `QUEUE_NAMES` — the one definition, imported by the worker and by `/admin`                                            |
| `metrics.ts`          | In-process counter / gauge / histogram registry + Prometheus rendering                                                |
| `scrub.ts`            | `scrubSecrets` / `scrubContext` — inline secret redaction for free text                                               |
| `errors.ts`           | `captureError` (de-duplicated `ErrorEvent` rows) + reads                                                              |
| `redis.ts`            | A lazily-connected `ioredis` client + `pingRedis`                                                                     |
| `queues.ts`           | Read-only BullMQ introspection: depth, recent failures, repeatable ticks                                              |
| `worker-heartbeat.ts` | `writeHeartbeat` (worker) + staleness classification (readers)                                                        |
| `health.ts`           | `checkDatabase` / `checkRedis` / `checkAiProviders` / `checkExternalIntegrations` / `checkWorker` → `runHealthChecks` |
| `admin-metrics.ts`    | DB-derived aggregates for the dashboards (AI usage, crawler, jobs, subs, usage, DB perf)                              |
| `admin-lists.ts`      | Paged, secret-free entity lists for the `/admin` tables                                                               |

Re-exported as `import { observability } from '@growth-agent/services'` and as
the subpath `@growth-agent/services/observability`.

> `queues.ts` and `redis.ts` pull in `bullmq` / `ioredis` (Node built-ins). They
> are only reached from Node route handlers / server components / the worker —
> never from `middleware.ts` (edge) and never eagerly from `instrumentation.ts`
> (the `import()` there is behind a `NEXT_RUNTIME === 'nodejs'` check so webpack
> drops it from the edge bundle).

---

## 2. `/admin` — internal administration

Route group `apps/web/app/(admin)/admin/*`, gated by `requirePlatformStaff()`
(a `PlatformStaff` row; the edge middleware `authorized` callback also blocks
non-staff before the page renders). Thirteen sections:

| Section          | Reads                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| Overview         | `platformCounts`, `runHealthChecks`, `aiUsageSummary`, recent errors         |
| Users            | `listUsers` (email / name search)                                            |
| Organizations    | `listOrganizations`, `getOrganizationDetail`                                 |
| Subscriptions    | `listSubscriptions`, `subscriptionsOverview` — Stripe ids masked             |
| Usage            | `usageOverview` (from `UsageCounter`)                                        |
| AI usage         | `aiUsageSummary`, `recentExpensiveAgentRuns`                                 |
| Agent runs       | `listAgentRuns` (status / agent / org filters)                               |
| Crawler jobs     | `crawlerSummary`, `listCrawls`                                               |
| API integrations | `listOAuthConnections` — token columns never selected                        |
| Errors           | `listErrorEvents`, `errorStats`, `getErrorEvent`                             |
| Audit logs       | `listAuditLogs` (action / org / actor filters)                               |
| System health    | health checks + the operational metrics (below) + DB perf + worker fleet     |
| Background jobs  | `getQueueDepths`, `getAllRecentFailedJobs`, `getRepeatableTicks`, heartbeats |

All lists paginate (`?page`), use explicit Prisma `select`s, and pass free text
through `scrubSecrets`.

---

## 3. Operational metrics

Two sources, by design:

- **In-process registry** (`metrics.ts`) — request latency, error rate, AI /
  external-API call counts + durations, per-queue job duration. Rendered at
  `GET /api/metrics` (web) and `:$WORKER_HEALTH_PORT/metrics` (worker) in
  Prometheus text format. **Per-instance and reset on deploy** — a Prometheus
  scrape turns it into history. The admin "System health" page shows the
  current web instance's snapshot, labelled "this instance".
- **Database aggregates** (`admin-metrics.ts`) — the durable numbers: AI token
  usage / cost / latency from `AgentRun`, crawler failures + duration from
  `Crawl`, job duration from `AutomationRun`, and PostgreSQL counters
  (`pg_stat_database`, `pg_stat_activity`, and `pg_stat_statements` when the
  extension is installed).

| Metric (spec)        | Where                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- |
| request latency      | `http_request_duration_ms` histogram (registry), per route                          |
| error rate           | `http_errors_total` / `http_requests_total` (registry) + `errors_captured_total`    |
| API failures         | `external_api_failures_total` / `external_api_calls_total` (registry)               |
| AI latency           | `AgentRun.finishedAt − startedAt` p50/p95 (DB) + `ai_call_duration_ms` (registry)   |
| AI token usage       | `AgentRun.tokensPrompt + tokensCompletion` (DB), windowed                           |
| AI cost estimates    | `AgentRun.costUsd` (DB) — the internal price table, never billed                    |
| crawler failures     | `Crawl` status `FAILED` rate (DB), windowed                                         |
| queue depth          | BullMQ `getJobCounts` per queue (live) + last heartbeat snapshot (fallback)         |
| job duration         | `AutomationRun.durationMs` p50/p95 (DB) + `job_duration_ms` per queue (registry)    |
| database performance | cache-hit ratio, connections, rollback ratio, deadlocks, size, slow statements (DB) |

Metric-recording helpers (`recordHttpRequest`, `recordExternalCall`,
`recordAiCall`, `recordJob`, `recordCrawlOutcome`, `recordUsageRejection`) are
the intended call sites; `withRouteObservability` and the worker's
`instrumentJob` wire the HTTP and job ones automatically.

---

## 4. Structured logs & correlation ids

- **Logger:** `@growth-agent/observability` `createLogger(name)` — pino JSON,
  one line per request / job, with the key-path redaction list in
  `packages/observability/src/logger.ts`. The worker now uses this factory too
  (it previously had a bare pino instance with no redaction).
- **Correlation id:** resolved per request in the observability layer —
  `withRouteObservability` for route handlers, the `cache()`d
  `getCorrelationId()` for server components. A well-formed inbound
  `x-correlation-id` from a trusted proxy is kept, otherwise a `req_<24hex>` id
  is minted. It is threaded into jobs via `job.data.correlationId` (the
  worker's `instrumentJob` resolves it and binds it to the job's child
  logger), and `ErrorEvent.correlationId` ties a captured fault back to its
  request / job log line. It is **not** set in `middleware.ts`: wrapping
  NextAuth's `auth()` with a handler in this beta drops the `?callbackUrl=` on
  the unauthenticated redirect, so the middleware is left as the bare
  `export default auth`.

---

## 5. Not exposing secrets

Layered:

1. **Log redaction** — pino `redact` paths (auth headers, cookies, `*.token`,
   `*.*Secret`, `*.*Cipher`, …).
2. **`scrubSecrets`** on any free text that is persisted or shown: vendor key
   shapes (`sk-…`, `sk-ant-…`, `AIza…`, `whsec_…`, `xox[bp]-…`), `Authorization`
   header values, JWTs, connection-string credentials, and `NAME=value` where
   NAME looks like a secret. Applied by `captureError` (message + stack) and by
   the admin list mappers (`Crawl.error`, `OAuthConnection.lastError` /
   `IntegrationHealth.detail`).
3. **Explicit `select`** in every admin query — the `OAuthConnection`
   `*Cipher` / `*Iv` / `*AuthTag` / `keyId` columns are never read.
4. **Masking** — Stripe `customer` / `subscription` ids show as `cus_ab…wxyz`.
5. **`/api/metrics`** requires a `Bearer $METRICS_TOKEN` or a platform-staff
   session; it is never public.

---

## 6. Health checks

`GET /api/health` (web, always 200; body `status` ∈ `ok | degraded | down`):

| Check                   | Logic                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`              | `SELECT 1`                                                                                                                                   |
| `redis`                 | `PING` via the observability client (2.5s timeout)                                                                                           |
| `ai_provider`           | credentials present ⇒ `ok`; none ⇒ `unconfigured`; `?deep=1` (platform staff only) makes one cheap authenticated GET per configured provider |
| `external_integrations` | `OAuthConnection` status counts — any `ERROR`/`EXPIRED`/`REVOKED` ⇒ `degraded`                                                               |
| `worker`                | freshest `WorkerHeartbeat` age — >45s ⇒ `degraded`, >90s or none ⇒ `down`                                                                    |

The worker serves `GET /healthz` (200 when Redis is `ready`, 503 otherwise) and
`GET /metrics` on `WORKER_HEALTH_PORT` (default 9090) for an orchestrator probe
and a Prometheus scrape.

---

## 7. Worker heartbeat

Every ~15s the worker upserts its `WorkerHeartbeat` row (`workerId` =
`hostname:pid`) with the queue-depth snapshot it just read, `redisOk`, and
cumulative `jobsProcessed` / `jobsFailed`. Readers classify staleness (§6). The
row is the fallback for queue depth when the web process cannot reach Redis.

---

## 8. New tables

`ErrorEvent` and `WorkerHeartbeat` — both **non-tenant** (no `organizationId`
FK, like `BillingEvent`). Migration `20260916120000_admin_observability`
(additive). See `DATABASE.md`.

---

## 9. Documented limitations

- The in-process registry is **per-instance and volatile**. Fleet-wide history
  needs a Prometheus scraper; nothing here stores time-series.
- No tracing spans yet — the OpenTelemetry SDK is deferred (ADR-0028). `pino`
  correlation ids are the cross-cut for now.
- No alerting — thresholds (`heartbeat` staleness, error-rate spike, cost/min)
  are surfaced on `/admin`, not pushed anywhere.
- `pg_stat_statements` is optional; when the extension is absent the "slowest
  statements" panel is empty (the rest of the DB panel still works).
- `/admin` is **read-only** — no user/org/subscription mutation from here.
- Redis is genuinely unreachable in most local test runs; `checkRedis` and the
  queue views degrade gracefully rather than throw.
