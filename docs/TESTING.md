# TESTING.md

## Layers

| Layer       | Tool                                           | Scope                                                                                                 |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Unit        | Vitest                                         | Pure logic in `packages/*` and `apps/*/src/lib`.                                                      |
| Integration | Vitest                                         | DB (Prisma against a test Postgres), queue jobs, external API clients with recorded fixtures / mocks. |
| E2E         | Playwright                                     | `apps/web` critical flows in a real browser.                                                          |
| Security    | `pnpm audit`, `eslint` security rules, CI SAST | Dependency + code checks.                                                                             |

## Commands

```bash
pnpm test                                   # all unit suites via turbo
pnpm --filter @growth-agent/db test:integration   # DB integration (self-skips w/o DATABASE_URL)
pnpm --filter @growth-agent/web test:e2e          # Playwright smoke (boots a prod build)
```

## Conventions

- **Unit** suites live next to the code as `*.test.ts(x)`. No network, no
  database. Each package has its own `vitest.config.ts`.
- **Integration** suites are `*.integration.test.ts` under `packages/db`, run
  only by `test:integration` (the default `test` config excludes them). They
  connect to `TEST_DATABASE_URL` or `DATABASE_URL`; if the database is
  unreachable a `beforeAll` marks the suite skipped so `pnpm test` stays green
  on a machine with no database. CI provides a Postgres service and runs
  `migrate:deploy` first.
- **E2E** is `apps/web/e2e/*.spec.ts`. `playwright.config.ts` boots `next start`
  on port 3100 with placeholder env; the smoke suite covers the public pages,
  `/app` → `/login` route protection, `/api/health`, and a mobile viewport — no
  database required. Deeper flows (real sign-in, org management, integrations)
  are added with their phases.
- Vitest's e2e `.spec.ts` files are excluded from the web unit config.
- **Billing & usage** (operator's "Phase 10"): `packages/services/src/billing/*.test.ts`
  and `packages/services/src/usage/*.test.ts` — the plan catalog (tier ordering,
  monotonic limits, config is the only price source), Stripe webhook signature
  verification (valid / tampered / stale / multi-sig), the hand-rolled Stripe
  gateway with an injected `fetch` (form encoding, error mapping, the
  `NullBillingGateway`), entitlement resolution (OVERRIDE beats PLAN, expired
  override ignored), subscription mapping, checkout / plan-change / cancel /
  resume against a fake gateway, **webhook idempotency** (replaying an event id
  does no further work), and the metering cycle (`checkUsage` verdicts,
  idempotent `recordUsage`, `enforceUsage` → 429, self-healing rollup, gauges).
  All use in-memory fakes — no Stripe, no database.
- **Reporting** (operator's "Phase 11"): `packages/services/src/reports/*.test.ts`
  — the hand-rolled PDF writer (valid `%PDF` structure, wrapping never overflows,
  page breaks, deterministic bytes, string escaping), CSV rendering (all seven
  sections, comma/quote/newline escaping), **public redaction** (subject/org
  labels genericised, emails/URLs/handles/ids scrubbed, monetary amounts hidden,
  idempotent), deterministic section assembly + the historical-changes diff,
  the executive summary (deterministic fallback, grounded pass adopted when
  clean, dropped on hallucination/guarantee/model error), `buildReportSnapshot`
  end-to-end (all seven sections, previous-snapshot diff), the report lifecycle
  (`generateReport` BUILDING→READY, REPORTS meter enforced then recorded, FAILED
  path, tenant scope) and share links (token shape, expiry, revoke,
  `getReportForShare` returns a redacted snapshot and 404s an invalid token).
  All in-memory fakes — no database. `reports/sample.ts` holds a shared
  `ReportSnapshot` fixture.
- **Automation engine** (operator's "Phase 12"):
  `packages/services/src/automation/*.test.ts` — the hand-rolled cron parser
  (wildcards / lists / ranges / steps, `7`→Sunday, malformed rejection, the
  dom/dow "either" rule) and `nextRunAfter` for daily / weekly / monthly / a
  never-firing expression; rule CRUD (cron + `nextRunAt` computed, **owner
  lacks the permission → refused**, custom-cron + config validation, pause
  clears `nextRunAt`, resume reschedules + clears failures, tenant scope);
  the runner (`claimRun` idempotency, success resets `failureCount` +
  reschedules, failure → `RETRY_SCHEDULED` with an exponential `nextAttemptAt`,
  `FAILED` after `maxRetries`, `FAILING` at 5 / `DISABLED` at 10, **owner lost
  the role → `SKIPPED` and the job is never dispatched**, `retryDelayMs`
  curve); the **no-external-publish invariant**
  (`assertNoExternalPublish()`, no `requiredAction === 'publish:external'`);
  dispatch routing (each task type calls the right mocked job wrapper,
  `SEO_ISSUE_ALERT` / `CONTENT_OPPORTUNITY` open a `Task`); and the sweep jobs
  (due rules claimed + executed, paused skipped, a duplicate tick claims
  nothing, retry-sweep picks up due retries). All in-memory fakes — no
  database, no Redis; downstream job wrappers are `vi.mock`ed.

- **Admin & observability** (operator's "Phase 13"):
  `packages/services/src/observability/*.test.ts` — the metrics registry
  (label-order-independent counter keys, gauge last-write, approximate
  histogram quantiles, Prometheus `_bucket`/`_sum`/`_count` rendering, the
  `recordHttp*` / `recordAi*` semantic helpers); the secret scrubber (vendor
  key shapes, `Authorization` values, JWTs, connection-string credentials,
  `NAME=secret` assignments redacted; ordinary text and short ids left alone;
  `scrubContext` drops sensitive keys); `captureError` (a repeat folds into the
  same `fingerprint` with a bumped `count`, a different route ⇒ a new
  fingerprint, message/stack scrubbed + capped, **never throws** when the DB
  write fails); the health checks (`database` ok/down, `ai_provider`
  unconfigured/configured without a network call, `external_integrations`
  degraded when connections are in error, `worker` down with no heartbeat,
  `runHealthChecks` returns all five with a valid overall status); the worker
  heartbeat (BigInt coercion, staleness → ok/degraded/down, `redisOk:false` ⇒
  degraded, `workerFleetHealth` picks the freshest); and the admin aggregates
  (`aiUsageSummary` token/cost/failure-rate/latency-percentile maths,
  `crawlerSummary` failure rate, `jobDurationSummary` tolerating an unreachable
  Redis; `maskId`; `listOAuthConnections` never surfaces a `*Cipher` field and
  scrubs `lastError`). All in-memory fakes — no database, no Redis. The e2e
  smoke suite also asserts `/api/health` returns the five-dependency body and
  `/api/metrics` is not anonymously readable.

- **Security hardening** (operator's "Phase 14", `docs/SECURITY-AUDIT.md`):
  `packages/services/src/security/rate-limit.test.ts` — fixed-window counting,
  block-after-limit with a retry hint, per-key isolation, and **fail-open when
  Redis errors** (the limiter must never lock users out).
  `packages/services/src/security/untrusted.test.ts` — `wrapUntrusted` fencing,
  label normalisation, and **neutralising an input that injects its own
  BEGIN/END markers**. `packages/services/src/integrations/oauth-csrf.test.ts` —
  H-1 regression: `completeYouTubeConnect` / `completeTikTokConnect` reject a
  mismatched `actingUserId` with `permission_denied` before any token exchange.
  `seo/ssrf.test.ts` extended with decimal / hex / octal / short
  numeric-hostname forms.

- **Full QA pass** (operator's "Phase 15", `docs/QA.md` is the coverage map):
  three new **integration** suites that run against CI Postgres and self-skip
  locally — `security/tenant-isolation.integration.test.ts` (cross-tenant reads
  of a report / automation / conversation return `null` / `resource_not_found`;
  a same-org user still can't read another user's conversation),
  `automation/idempotency.integration.test.ts` (the real
  `@@unique([automationRuleId, scheduledFor])` blocks a duplicate tick; three
  concurrent `claimRun`s produce one row) and
  `billing/webhook.integration.test.ts` (a redelivered Stripe event id is
  `processed` once then `deduped`; two concurrent deliveries → one row). Two new
  **e2e** specs — `e2e/api.spec.ts` (HTTP-contract: hardening headers incl. CSP,
  no CORS / no `x-powered-by`, `/api/health` shape + burst-safety, `/api/metrics`
  auth, webhook 400/200/malformed, agent-stream never streams unauth, OAuth
  callback error params, NextAuth `csrf` / `providers` endpoints, share-token 404) and `e2e/ui.spec.ts` (auth form + its failure state, session-expired
  notice, 375-px mobile layout with a no-horizontal-overflow assertion on every
  public page, the 404 page). Plus `e2e/authed.spec.ts` — authenticated browser
  workflows that mint a NextAuth session cookie for a directly-seeded user
  (dashboard renders, empty state, VIEWER-vs-OWNER UI gating, `/admin` staff
  access, `sessionVersion` revocation → re-login); gated by `E2E_AUTHED=1` +
  Postgres, so it runs in CI and skips on a plain `pnpm test:e2e`.

## Rules

- New behavior ships with tests. Bug fixes ship with a regression test.
- No network calls in unit tests. External APIs are mocked or replayed.
- AI: mock the `AIProvider` interface; assert on prompt construction, schema
  validation of outputs, and usage recording — never call a real model in CI.
- Integration tests clean up the rows they create (unique per-run prefixes);
  never point them at a shared/dev database with real data.
- E2E will grow to cover: sign-in (dev credentials), org create + switch,
  member invite + accept, connect-integration (mocked OAuth), start SEO crawl,
  approve a recommendation.
- Coverage target: 80% lines in `packages/core`, `packages/ai`,
  `packages/services`; critical paths in `apps/*` covered by integration/e2e
  rather than a blanket %.
