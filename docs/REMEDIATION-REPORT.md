# REMEDIATION-REPORT.md

Phase 19 — production gap remediation. Every issue classified **BLOCKER /
CRITICAL / HIGH** in `docs/FORENSIC-AUDIT.md` is addressed here. No fake
implementations: anything that depends on an external API is either implemented
for real or explicitly marked externally-dependent. No unrelated features.

**Gates (this machine):** `pnpm format:check` · `pnpm lint` 14/14 (0 warn) ·
`pnpm typecheck` 14/14 · `pnpm test` — `@growth-agent/services` **514** +
`@growth-agent/worker` **2** + ai/core/observability/ui **9** · `pnpm test:scripts`
**11** · `node scripts/check-tenant-scope.mjs` · `node scripts/audit-allow.mjs` ·
`pnpm --filter @growth-agent/web build` (normal) · `NEXT_OUTPUT_STANDALONE=1`
build. **Integration / Playwright e2e / Docker build+compose run in CI**
(no Postgres or Docker in the authoring environment).

---

## 1 · D-1 / P-2 (BLOCKER) — container + standalone build never exercised

- **Problem.** CI only ran `docker buildx build --call=check` (a linter) with
  `continue-on-error: true`; the `NEXT_OUTPUT_STANDALONE=1` build that
  `Dockerfile.web` depends on was never run anywhere.
- **Root cause.** No job actually built or booted the images.
- **Fix.** `.github/workflows/ci.yml`:
  - new `docker` job — `docker build -f Dockerfile.web .` and `-f Dockerfile.worker .`
    for real, then a **compose smoke test**: throwaway `postgres:16` + `redis:7`,
    run the worker image's `migrate:deploy`, start `web` + `worker`, and assert
    `curl /api/health` returns a body with `"status"` and the worker `/healthz`
    answers.
  - `verify` job gained a `Next standalone build` step (`NEXT_OUTPUT_STANDALONE=1`).
  - the old `--call=check` step is removed (superseded by the real build).
- **Files.** `.github/workflows/ci.yml`.
- **Verification.** Runs in CI. Locally: `pnpm --filter @growth-agent/web build`
  and the same with `NEXT_OUTPUT_STANDALONE=1` both exit 0.
- **Residual.** The compose smoke needs Docker-in-Docker/buildx on the runner;
  if a hosted runner can't, it degrades to build-only. A real DNS cutover still
  needs a manual staging deploy.

## 2 · D-2 / P-8 (BLOCKER) — magic-link sign-in inert by default

- **Problem.** `EMAIL_TRANSPORT` defaulted to `console` (link only logged); a
  deploy could ship with **no** working sign-in path (Google OAuth is optional).
- **Root cause.** Only a Nodemailer/SMTP path existed; `RESEND_API_KEY` in
  `.env.example` was read by nothing.
- **Fix.**
  - `packages/services/src/auth/providers.ts` — real **Resend HTTP transport**:
    when `EMAIL_TRANSPORT=resend` (or unset with `RESEND_API_KEY` present),
    `sendVerificationRequest` POSTs to `https://api.resend.com/emails` with
    `fetch` (no SDK, no new dependency). `smtp` and `console` paths kept.
  - `packages/services/src/config/env.ts` `authDeliveryStatus()` — a prod config
    with no real email path **and** no Google OAuth is a hard boot error.
  - `scripts/check-env.mjs` — accepts `resend`; new "no working sign-in path"
    check (blocking in prod, warning otherwise); `RESEND_API_KEY` catalogued.
  - `.env.example` — documents `console | smtp | resend` and the prod requirement.
- **Files.** `auth/providers.ts`, `config/env.ts`, `scripts/check-env.mjs`,
  `scripts/check-env.test.mjs` (+2 tests), `.env.example`.
- **Verification.** `pnpm test:scripts` (11 pass, incl. "blocks a production
  config with no working sign-in path" and "accepts EMAIL_TRANSPORT=resend").
- **Externally-dependent.** A real send needs a `RESEND_API_KEY` (or SMTP) and
  SPF/DKIM/DMARC on the sending domain — deployment config, not code.

## 3 · D-3 / M-10 / S-8 / T-1 (CRITICAL) — no boot-time env validation

- **Problem.** `apps/web/src/env.ts` (the file the Dockerfile comment credited)
  was imported by nothing; a container missing `REDIS_URL` / `ENCRYPTION_KEY` /
  `AUTH_URL` started fine and failed at first use.
- **Fix.**
  - new `packages/services/src/config/env.ts` — Zod schema, **prod-strict**
    (required core set, `AUTH_URL == NEXT_PUBLIC_APP_URL` https, `AUTH_DEV_LOGIN
!= true`, a sign-in path) when `NODE_ENV=production` and not `next build` /
    vitest; type validation always. `loadEnv()` throws with a field list;
    `export const env = loadEnv()` validates on import.
  - imported for its side effect from `apps/web/app/layout.tsx` (server root) and
    `apps/worker/src/main.ts`.
  - `apps/web/src/env.ts` **deleted**; `Dockerfile.web` comment corrected.
  - `packages/services/package.json` exports `./config`.
- **Files.** `config/env.ts` (new), `apps/web/app/layout.tsx`,
  `apps/worker/src/main.ts`, `packages/services/package.json`, `Dockerfile.web`,
  `apps/web/src/env.ts` (deleted).
- **Verification.** typecheck 14/14; `pnpm --filter @growth-agent/web build`
  (build sets `NEXT_PHASE=phase-production-build` → strict rules correctly skip,
  type checks still run). A misconfigured real container now aborts at boot.

## 4 · M-1 (HIGH) — notification system missing

- **Problem.** No `Notification` model, no delivery; a user could not learn that
  a crawl finished / a report was ready / an automation is failing without
  opening the app. Invitations were manual link copy-paste.
- **Fix.**
  - **Schema** (migration `20260917120000_notifications_lifecycle`) — `Notification`
    model (`organizationId`, nullable `userId`, `kind`, `level`, `title`, `body`,
    `linkPath`, unique `dedupeKey`, `readAt`, `emailedAt`, …) + 2 indexes + FKs
    `onDelete: Cascade`. New `NotificationLevel` enum.
  - **Service** `packages/services/src/notifications/` — `createNotification`
    (modelled on `recordAudit`: **never throws**; idempotent on `dedupeKey`),
    `listNotifications`, `unreadCount`, `markRead`, `markAllRead`. Email fan-out
    (`email.ts`, reuses the Resend/SMTP transport) fires only for a targeted
    user **and** only when a real transport is configured.
  - **Wired to existing completion points** (no new triggers):
    `reports/generate.ts` (READY → SUCCESS, FAILED → WARNING),
    `automation/runner.ts` (rule → FAILING/DISABLED → owner),
    `seo/jobs.ts` `startCrawl` (finished → SUCCESS, blocked → WARNING),
    `organizations/index.ts` `inviteMember` (one row per existing member).
  - **API + UI** — `GET/POST /api/notifications`; `NotificationBell` in the app
    header (polls, badge, dropdown, mark-read); `/app/notifications` page;
    nav entry.
- **Files.** `packages/services/src/notifications/{index,email,index.test}.ts`,
  `schema.prisma`, migration, `reports/generate.ts`, `automation/runner.ts`,
  `seo/jobs.ts`, `organizations/index.ts`, `apps/web/app/api/notifications/route.ts`,
  `apps/web/app/(app)/app/notifications/page.tsx`,
  `apps/web/src/components/app/{notification-bell,notifications-view}.tsx`,
  `apps/web/src/components/app/{app-shell,nav}.tsx`, services barrel.
- **Verification.** `notifications/index.test.ts` (4: dedupe, never-throws,
  org+user scoping, markRead). Services suite 514 pass.
- **Out of scope / externally-dependent.** Weekly digests are **not**
  implemented; per-user read state for org-wide rows uses a single shared
  `readAt` (adequate for broadcast notices).

## 5 · M-2 / D-8 (HIGH) — no account/org deletion or DSR export

- **Problem.** `org:delete` was a defined-but-unimplemented RBAC action; no
  data-export; `crawl_pages` / `crawl_links` FKs were `ON DELETE RESTRICT` (would
  block a real org delete).
- **Fix.**
  - **FK redefinition** (same migration) — `crawl_pages_organizationId_fkey` and
    `crawl_links_organizationId_fkey` → `ON DELETE CASCADE`. Constraint
    redefinition only — **no `DROP TABLE`/`DROP COLUMN`**, property preserved.
  - **`packages/services/src/organizations/lifecycle.ts`** —
    `requestOrganizationDeletion` (`authorize('org:delete')`, refuses the
    actor's only org, sets `deletionScheduledAt = now + grace`, audit +
    org-wide notification), `cancelOrganizationDeletion`, `purgeOrganization`
    (re-checks the window, `prisma.organization.delete()` → cascades),
    `requestAccountDeletion` (bumps `sessionVersion`, cascades sole-owner orgs,
    does **not** set `deletedAt` so the user can sign back in to cancel),
    `cancelAccountDeletion`, `purgeUser` (anonymise: email → tombstone,
    name/image null, memberships/accounts/sessions removed), and
    `runLifecycleSweepJob` (hourly).
  - **DSR export** `organizations/export.ts` — `exportOrganizationData` composes
    the per-module reads into one JSON doc (encrypted OAuth tokens excluded);
    `GET /app/settings/export` route (`org:update`, rate-limited).
  - **Worker** — `lifecycle-sweep` job type folded into the existing `automation`
    queue + an hourly repeatable tick in `apps/worker/src/main.ts`.
  - **UI** — Settings "Danger zone" tab: export button, typed-confirm org
    deletion, typed-confirm account deletion, cancel banners. Server actions in
    `settings-actions.ts`.
  - `ACCOUNT_DELETION_GRACE_DAYS` env (default 7, clamped 1–90).
- **Files.** `schema.prisma`, migration, `organizations/{lifecycle,export,index}.ts`,
  `organizations/lifecycle.test.ts`, `apps/worker/src/processors/automation.ts`,
  `apps/worker/src/main.ts`, `apps/web/src/server/settings-actions.ts`,
  `apps/web/app/(app)/app/settings/{page.tsx,export/route.ts}`,
  `apps/web/src/components/app/settings/settings-tabs.tsx`.
- **Verification.** `organizations/lifecycle.test.ts` (sole-org refusal,
  schedule+cancel, purge window guard, sole-owner cascade + `sessionVersion`
  bump without `deletedAt`). Org-purge cascade incl. `crawl_pages`/`crawl_links`
  is asserted by the crawler integration suite in CI.

## 6 · M-9 / S-1 (HIGH) — Postgres RLS — **deferred, with a backstop**

- **Problem.** RLS is documented as the tenant-isolation backstop; no policy in
  any migration.
- **Why deferred.** The approved "scoped RLS via `withOrgScope`" is not viable
  as specified — `withOrgScope` exists in `packages/db` but is **called
  nowhere**; services do ~321 direct `prisma.<tenantModel>` calls across 28
  files. Enabling `FORCE ROW LEVEL SECURITY` without first threading a
  per-transaction `app.current_org` GUC through all of them makes nearly every
  tenant read return zero rows, and that retrofit cannot be verified without a
  live Postgres (unavailable this session). Operator confirmed the deferral.
- **What shipped instead.**
  - `scripts/check-tenant-scope.mjs` — fails CI when a
    `findMany | findFirst | updateMany | deleteMany | aggregate | groupBy | count`
    on a tenant table in `packages/services/src` has no nearby `organizationId`
    (or an org-derived FK like `crawlId`), unless annotated `// tenant-scope-ok:`.
    Wired into the `verify` job; `pnpm check:tenant`.
  - The tenant-isolation integration suite remains the enforced backstop.
- **Files.** `scripts/check-tenant-scope.mjs` (new), `.github/workflows/ci.yml`,
  `package.json`.
- **Verification.** `node scripts/check-tenant-scope.mjs` → clean on current
  code.
- **Still open (tracked HIGH).** Real RLS needs its own phase: a `withTenant()`
  wrapper across the call sites, a second non-owner DB role, `FORCE` policies +
  a `runAsSystem` bypass for auth/webhook/admin/health, and Postgres-backed
  tests. ADR-0035 §5.

## 7 · D-4 (HIGH) — monitoring configured but not deployed

- **Problem.** `deploy/prometheus.yml` + `deploy/alerts.yml` existed but nothing
  ran them; client-side and edge-runtime errors were captured nowhere.
- **Fix (code half).**
  - `apps/web/app/api/client-error/route.ts` — unauthenticated (errors happen
    around auth), per-IP rate-limited, body-capped POST sink → `captureError`
    with `context.client`.
  - `apps/web/src/components/providers.tsx` — throttled `window.onerror` /
    `onunhandledrejection` handlers + an exported `reportClientError`.
  - `apps/web/app/{error,global-error}.tsx` + `(app)/app/error.tsx` — POST on
    mount.
  - `apps/web/instrumentation.ts` — `onRequestError` now also handles the **edge**
    runtime (POSTs to `/api/client-error`, since `@growth-agent/services` is
    Node-only there).
- **Fix (infra half).** `docker-compose.production.yml` — `prometheus` +
  `alertmanager` services behind `profiles: ['monitoring']`; new
  `deploy/alertmanager.yml` (NULL receiver + commented Slack/PagerDuty);
  `deploy/prometheus.yml` alerting block uncommented.
- **Files.** as above + `deploy/alertmanager.yml`, `deploy/prometheus.yml`,
  `docker-compose.production.yml`.
- **Still an operator step.** Actually running `--profile monitoring up` and
  wiring a real Alertmanager receiver + an external `/api/health` uptime probe.
  To be documented in `docs/DEPLOYMENT.md` §16.

## 8 · D-5 / S-2 (HIGH) — `pnpm audit` did not gate CI

- **Problem.** `Security audit` step had `continue-on-error: true`; a new
  high/critical advisory would never fail the build.
- **Fix.** `scripts/audit-allow.mjs` runs `pnpm audit --prod --json` and fails on
  any **moderate+/high/critical** advisory not in `.audit-allowlist.json`.
  Allowlist entries carry a `reason` + `reviewBy` date and match by GHSA id or
  module. CI step no longer `continue-on-error`.
- **Currently allowlisted (unavoidable today).** `nodemailer` (peer-locked to v8
  by `@auth/core@0.41.3` — the Resend transport is the recommended prod path);
  `deepmerge-ts` (Prisma-CLI build-time only); `ai` / `@ai-sdk/provider-utils`
  (unused file-upload feature; clears with the AI SDK v5 migration).
- **Files.** `scripts/audit-allow.mjs`, `.audit-allowlist.json`,
  `.github/workflows/ci.yml`, `package.json` (`check:audit`).
- **Verification.** `node scripts/audit-allow.mjs` → exit 0, "no unexpected
  moderate+/high/critical advisories".

## 9 · Bundled — B-1 / B-2 / T-2

- **B-1 / D-7** — deleted the empty untracked
  `packages/db/prisma/migrations/20260907120000_youtube/` directory (was
  breaking local `prisma migrate` with P3015).
- **B-2** — added `apps/worker/vitest.config.ts` (`include: ['src/**/*.test.ts']`)
  so the worker suite stops inheriting the repo-root `scripts` glob; added a
  real `apps/worker/src/processors/automation.test.ts` (routes sweep /
  retry-sweep / execute / lifecycle-sweep). `apps/worker/tsconfig.json` no longer
  excludes `*.test.ts`.
- **T-2** — `.env.example` moves `S3_*` / `SENTRY_DSN` / `OTEL_*` /
  `UPSTASH_*` / GSC under a `# --- NOT IMPLEMENTED (planned) ---` block;
  `RESEND_API_KEY` promoted to the auth block (now implemented). `CLAUDE.md`
  "Stack" corrected (object storage / Sentry / OTEL marked planned; RLS marked a
  tracked follow-up).
- Stale `schema.prisma` header comment ("currently covers Phase 2") rewritten.

---

## What is NOT fixed in this phase (out of scope — MEDIUM / LOW)

Object storage, Sentry SDK, OpenTelemetry, Google Search Console, per-route
loading/error/empty states, `next/image` thumbnails, mobile/axe e2e,
timezone-aware automations, dedicated SEO sub-analysis screens, an edge/WAF
rate-limit layer, a strict nonce CSP, `apps/web` route-handler unit tests,
unused-dep pruning, `feature-placeholder.tsx`. Real Postgres RLS (see §6) is the
one **HIGH** that remains open, by an explicit, recorded decision.

## Migrations

`20260917120000_notifications_lifecycle` — 1 enum, 1 table, 3 nullable columns,
2 FK redefinitions. **No `DROP TABLE` / `DROP COLUMN`** — the 0-drop property
holds. Additive except the two `RESTRICT → CASCADE` constraint swaps.
