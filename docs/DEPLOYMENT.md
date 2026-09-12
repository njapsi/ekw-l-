# DEPLOYMENT.md

Production deployment runbook. **Do not deploy until every check in
`docs/QA.md` and step 0 below passes.**

Companion files: `Dockerfile.web`, `Dockerfile.worker`, `.dockerignore`,
`docker-compose.production.yml`, `deploy/` (Caddyfile, Prometheus, alerts,
backup scripts), `scripts/check-env.mjs` (`deploy/README.md` indexes them).

**Rehearsing this on a staging environment first?** See `docs/STAGING.md` — a
full, staging-flavored walkthrough of everything below (Supabase + Upstash
instead of a bespoke managed-service setup, Stripe TEST mode, OAuth apps left
in Testing/sandbox mode) using `docker-compose.staging.yml` +
`.env.staging.example`.

---

## Architecture (ADR-0031)

**Two independently-deployed containers** built from this monorepo:

| Service  | Image                                            | Runs                                             | Scales on      | Health                                                                   |
| -------- | ------------------------------------------------ | ------------------------------------------------ | -------------- | ------------------------------------------------------------------------ |
| `web`    | `Dockerfile.web` — Next.js **standalone**        | `node apps/web/server.js` (port 3000)            | request volume | `GET /api/health` (always 200 when up; body `status` = ok/degraded/down) |
| `worker` | `Dockerfile.worker` — Node + Playwright Chromium | `tsx apps/worker/src/main.ts` (health port 9090) | queue depth    | `GET :9090/healthz` + a `WorkerHeartbeat` DB row every ~15s              |

The worker consumes `packages/*` as TypeScript source (like `pnpm dev`), so it
runs via `tsx` rather than a compiled bundle. `web` uses Next's file-tracing
standalone output, which inlines the workspace packages + the Prisma client.

**Managed, not containerised:** PostgreSQL, Redis, object storage, email, and
secrets. `docker-compose.production.yml` is a single-host convenience (adds
Caddy for TLS); on Fly/Render/ECS/k8s deploy the two images directly.

Production requirements → where they are met:

| Requirement         | Met by                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| HTTPS               | Caddy auto-TLS (compose) **or** the platform's TLS + `AUTH_URL=https://…`                                                     |
| Secure cookies      | automatic — NextAuth sets `__Secure-`/`__Host-` cookies + `Secure` when `AUTH_URL`/request is https (JWT sessions, ADR-0011)  |
| Production database | managed Postgres 16 + `pgvector`; `DATABASE_URL` (pooled) + `DIRECT_URL` (unpooled, migrations)                               |
| Managed Redis       | `REDIS_URL` → Upstash / ElastiCache / MemoryDB (queues, rate limits, idempotency)                                             |
| Object storage      | **not an implemented app feature** — no code reads `S3_*` (§3); the only real object-storage use is the backup bucket below   |
| Secrets manager     | env injected from the platform's secret store; `scripts/check-env.mjs` validates presence without printing values             |
| Database backups    | provider PITR **plus** `deploy/backup/pg-backup.sh` → object storage                                                          |
| Migrations          | `prisma migrate deploy` in a release step, **never at container boot** (§12)                                                  |
| Monitoring          | pino JSON logs + `/api/metrics` + `worker:/metrics` scraped by Prometheus (`deploy/prometheus.yml`); `/admin` dashboards      |
| Alerting            | `deploy/alerts.yml` (availability, error rate, latency, integration + AI failures, cost burn, job/crawler failures)           |
| Rate limiting       | app-level fail-open Redis limiter (Phase 14) on magic-link / OAuth / agent / health / crawl; add an edge/WAF layer at the CDN |
| CDN                 | put a CDN in front of `/_next/static` + `/public`; Caddy already sets `immutable` cache headers (§16)                         |

---

## 0. Pre-deploy checklist (must be green)

```bash
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test                       # unit
pnpm test:scripts               # scripts/check-env.mjs contract
pnpm --filter @growth-agent/db test:integration          # needs Postgres
pnpm --filter @growth-agent/services test:integration    # needs Postgres
pnpm --filter @growth-agent/web test:e2e                 # needs Postgres (E2E_AUTHED=1)
pnpm audit --prod               # review any high advisories
NEXT_OUTPUT_STANDALONE=1 pnpm --filter @growth-agent/web build   # Linux/CI only
pnpm --filter @growth-agent/worker build                         # typecheck
node scripts/check-env.mjs --file .env.production --target all    # 0 blocking
```

> The standalone `web` build fails on Windows (`EPERM` on symlinks) — build it
> in CI / the Docker image only. Local dev, tests and e2e use the normal build.

---

## 1. Production database

1. Provision **PostgreSQL 16** (Neon, RDS, Cloud SQL, or Crunchy). Pick a
   region close to the app.
2. Enable the `pgvector` extension (for future semantic memory) and, optionally,
   `pg_stat_statements` (feeds `/admin/system-health`):
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```
3. Create the database + an application role with `CREATE/SELECT/INSERT/UPDATE/
DELETE` but **not** superuser.
4. Capture two connection strings:
   - `DATABASE_URL` — through the provider's **pooler** (PgBouncer / Neon
     pooled), `?sslmode=require`. Used at runtime.
   - `DIRECT_URL` — the **unpooled** endpoint. Used only by `prisma migrate`.
5. Turn on automated backups + PITR with ≥ 7 days retention. Note the restore
   procedure.
6. Restrict inbound to the app/worker/CI egress IPs (or a private network).

## 2. Redis

1. Provision **managed Redis 7** (Upstash, ElastiCache, MemoryDB). One instance
   is enough for launch; it carries BullMQ queues, the rate limiter, and
   idempotency keys.
2. Set `maxmemory-policy` to **`noeviction`** — evicting a queue key loses jobs.
3. Require TLS (`rediss://`) and auth. Put it on the private network with the
   app + worker.
4. `REDIS_URL=rediss://default:<token>@<host>:<port>`.
5. The app rate limiter **fails open** if Redis is unreachable (logged) so a
   blip does not lock out sign-in — keep it monitored anyway.

## 3. Object storage

**Corrected (Phase 31 — final security review):** object storage for
application data (`S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY`) is a **planned, not implemented** feature — no code
in `apps/web` or `packages/services` reads any of those variables (confirmed
by grep; also documented in `.env.example`'s "NOT IMPLEMENTED" section and
`docs/FORENSIC-AUDIT.md`). Reports render on demand from the database;
nothing is uploaded anywhere. **Do not provision a bucket or set these
variables expecting the app to use them** — this section previously
implied otherwise. When object storage is actually implemented, this
section should be rewritten to match the real presigned-URL flow at that
time.

The one genuinely real object-storage use on a production deploy is the
**backups bucket**, which the Postgres backup script
(`deploy/backup/pg-backup.sh`) actually writes to:

1. Create a bucket (Cloudflare R2 or AWS S3), **private**, versioning on. A
   separate bucket from anything else — never reuse a bucket that also holds
   user-facing data.
2. Create a **separate, more restrictive** scoped key pair for it than any
   app credential: the writer (the cron host running `pg-backup.sh`) only
   ever needs `s3:PutObject` + `s3:ListBucket` on this bucket — never
   `GetObject` or `DeleteObject`, so a compromised backup host can still
   write new backups but can't read or destroy existing ones. Whoever
   performs an actual restore (`pg-restore.sh`) uses a second, separate key
   scoped to `s3:GetObject` + `s3:ListBucket` only, held somewhere the
   day-to-day backup host doesn't have access to. Never share the app's own
   credentials (there are none, per above) or reuse one key for both roles.
3. Set `BACKUP_S3_BUCKET` (e.g. `s3://growth-agent-backups`),
   `BACKUP_S3_ENDPOINT` (R2/MinIO need it; native S3 can omit),
   `BACKUP_RETENTION_DAYS`, and `BACKUP_GPG_RECIPIENT` — the last one is
   **required**, not optional: `pg-backup.sh` now refuses to upload an
   unencrypted dump (Phase 31 — a dump is the full tenant dataset: PII,
   OAuth-token ciphertext, everything; it must never sit in object storage
   in plaintext).

## 4. AI provider

1. Create an API key with **at least one** of: Anthropic (`ANTHROPIC_API_KEY`),
   OpenAI (`OPENAI_API_KEY`), Google (`GOOGLE_GENERATIVE_AI_API_KEY`).
   Without any key the product still runs — deterministically (keyword planning,
   assembled replies, no model narrative).
2. Set `AI_DEFAULT_PROVIDER` + `AI_DEFAULT_MODEL` to a model in
   `packages/ai/src/pricing.ts` (unknown models estimate cost as 0 and are
   flagged).
3. In the provider console set data retention to the strictest option and
   disable training on your data.
4. Set a spend alert on the provider side in addition to the `AiCostBurnRate`
   Prometheus alert.

## 5. Google OAuth

1. Google Cloud Console → **APIs & Services → OAuth consent screen**: External,
   app name, support email, the scopes
   `.../auth/youtube.readonly`, `.../auth/yt-analytics.readonly`, and
   `.../auth/yt-analytics-monetary.readonly` (the last is requested only when a
   user opts into revenue). Add the privacy-policy + terms URLs. Submit for
   verification (sensitive-scope review takes days–weeks — start early).
2. **Credentials → Create OAuth client ID → Web application**. Authorized
   redirect URI: `https://<APP_DOMAIN>/api/integrations/google/callback`.
   (Auth.js sign-in with Google, if enabled, also uses
   `https://<APP_DOMAIN>/api/auth/callback/google`.)
3. Set `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET`.
4. Add the production domain to **Authorized domains**.

## 6. YouTube APIs

1. In the same GCP project **enable**: _YouTube Data API v3_ and
   _YouTube Analytics API_.
2. Request a quota increase for _YouTube Data API v3_ (default 10 000 units/day
   is small for many tenants). `YOUTUBE_ORG_DAILY_QUOTA` slices the shared quota
   per connected account (default 2000).
3. Comply with the _YouTube API Services Developer Policies_ (data use limited
   to the feature the user asked for; no resale; no ads).

## 7. TikTok developer application

1. developers.tiktok.com → create an app. Add **Login Kit** and **Display API**;
   add **Content Posting API** only if you ship authorized publishing.
2. Scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`,
   `video.list` (+ `video.publish` opt-in). Redirect URI:
   `https://<APP_DOMAIN>/api/integrations/tiktok/callback`.
3. Submit the app for audit — **unaudited apps can only post `SELF_ONLY`
   (private) videos**, and Display API access is limited. Provide the demo
   video + privacy policy they ask for.
4. Set `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET`.

## 8. Payment provider (Stripe)

1. Stripe Dashboard → create the products + recurring **Prices** for
   CREATOR / PRO / AGENCY, monthly + yearly (6 prices). The app never hard-codes
   an amount — display prices live in `packages/services/src/billing/plans.ts`;
   only the Price IDs are env.
2. Set `STRIPE_SECRET_KEY` (live), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and the
   six `STRIPE_PRICE_*` ids. All-or-nothing — `check:env` blocks a partial set.
3. **Webhook**: add an endpoint `https://<APP_DOMAIN>/api/billing/webhook` for
   `checkout.session.completed`, `customer.subscription.*`, `invoice.*`. Copy
   the signing secret to `STRIPE_WEBHOOK_SECRET`. The handler verifies the HMAC
   before parsing and is idempotent on the event id.
4. Enable the **Customer Portal** (Billing → Customer portal) so `changePlan` /
   `cancel` can hand off.
5. With no Stripe env the app runs everyone on FREE and every billing mutation
   returns a clear "not configured" — safe to launch without billing.

## 9. Domain

1. Register / choose the apex, decide the app host (`app.example.com`
   recommended; keep the apex for marketing/DNS-only).
2. This host is the value of `APP_DOMAIN`, `AUTH_URL`, and `NEXT_PUBLIC_APP_URL`
   — they must all be the **same** `https://` origin, because the app trusts the
   `Host` header for magic-link / OAuth redirect URLs (SECURITY-AUDIT.md I-2).
3. Every OAuth redirect URI, the Stripe webhook URL, and the CDN origin use this
   host.

## 10. DNS

1. `A` / `AAAA` (or `CNAME` to the platform) for `app.example.com` → the load
   balancer / Caddy host.
2. If fronting with a CDN (Cloudflare), proxy the record; set SSL mode **Full
   (strict)**; create a cache rule that bypasses cache for `/app/*`, `/admin/*`,
   `/api/*` and caches `/_next/static/*` long.
3. Email deliverability for magic links: `SPF`, `DKIM`, `DMARC` for the sending
   domain (from your email provider's setup).
4. Ownership-verification records for connected websites are added by end users
   on **their** domains — nothing to do here.
5. After DNS propagates, Caddy (or the platform) issues the TLS cert
   automatically; confirm `https://app.example.com/api/health` responds.

## 11. Environment variables

1. Start from `.env.example`. Everything marked there for production must be set
   in the platform's **secret store** (not a checked-in file).
2. Required for every service: `NODE_ENV=production`, `DATABASE_URL`,
   `DIRECT_URL`, `AUTH_SECRET` (`openssl rand -base64 32`), `ENCRYPTION_KEY`
   (`openssl rand -base64 32`), `REDIS_URL`. Web also needs `AUTH_URL` +
   `NEXT_PUBLIC_APP_URL` (same https origin).
3. **`AUTH_DEV_LOGIN` must be unset or `false`** in production (it is also
   `NODE_ENV`-gated, but `check:env` blocks `true` as defence-in-depth).
4. Feature groups are all-or-nothing: Google pair, TikTok pair, the Stripe set,
   the S3 set, `EMAIL_TRANSPORT=smtp` ⇒ `EMAIL_SERVER`.
5. Validate before every release — this prints names + pass/fail only, never a
   value:
   ```bash
   node scripts/check-env.mjs --file .env.production --target web      # exit 0 required
   node scripts/check-env.mjs --file .env.production --target worker
   # or in a container with real env injected:
   node scripts/check-env.mjs --target all --json
   ```
6. `ENCRYPTION_KEY` rotation: the OAuth-token envelope stores a `keyId`, so roll
   the key + re-encrypt rows incrementally (runbook: `docs/SECURITY.md` §4).

## 12. Migrations

- **Never at container start.** Migrations run as a discrete release step
  against `DIRECT_URL`, with a fresh backup taken first.
- Command:
  ```bash
  pnpm --filter @growth-agent/db migrate:deploy      # = prisma migrate deploy
  # compose:  docker compose -f docker-compose.production.yml run --rm migrate
  ```
- Migrations are **checked-in, forward-only, and additive** (expand/contract):
  a new migration must be safe against the _previous_ app version so a rollout
  can be rolled back without a schema rollback. Column drops / type narrowing
  wait a release behind a code change that stops using them.
- Order per release: **backup → migrate → deploy `web` → deploy `worker`**.
- `prisma migrate deploy` only applies pending migrations and never resets; it
  is safe to run repeatedly (it no-ops when at head).

## 13. Application deployment (`web`)

1. Build: `docker build -f Dockerfile.web -t <registry>/growth-agent-web:<sha> .`
   (the image runs `pnpm db:generate` + `NEXT_OUTPUT_STANDALONE=1 next build`
   internally). Push.
2. `next.config.mjs` sets `outputFileTracingRoot` to the monorepo root and
   force-includes the Prisma engine; the runner copies `.next/standalone`,
   `.next/static`, `public`, and `node_modules/.prisma`.
3. Deploy with the env from §11. Set the platform health check to
   `GET /api/health` (expect HTTP 200; treat `status:"down"` as unhealthy only
   if you also want dependency-gated readiness). `start-period` ≥ 40s.
4. Run ≥ 2 replicas behind the LB for zero-downtime rollouts. The in-process
   metrics registry resets per replica per deploy — Prometheus stitches it.
5. Boot-time validation (`packages/services/src/config/env.ts`, imported by the
   web root layout and the worker entry) fails the process on an invalid
   production env — including "no working sign-in path" — so a bad deploy
   crash-loops with a readable field list instead of serving broken. Still run
   `node scripts/check-env.mjs --file .env.production --target all` first.

## 14. Worker deployment

1. Build: `docker build -f Dockerfile.worker -t <registry>/growth-agent-worker:<sha> .`
   (installs Playwright Chromium). Push.
2. Deploy as a **separate** service with the same env. Start 1–2 replicas;
   scale on queue depth (`/admin/jobs`, or the `job_*` metrics).
3. Health check: `GET :$WORKER_HEALTH_PORT/healthz` (200 iff Redis is `ready`).
   The port is **internal-only** — do not expose it publicly.
4. **Egress isolation:** the crawl/render pool must reach the public internet
   but **not** internal services or cloud metadata. Enforce with a network
   policy / egress proxy / dedicated subnet. The app-level SSRF guard
   (`seo/ssrf.ts`) is the second line, not the only one.
5. Graceful shutdown: `SIGTERM` closes the workers, the heartbeat, the health
   server and Redis, then exits — give the platform ≥ 30s stop grace.

## 15. Cron / scheduler deployment

- There is **no separate scheduler service**. On start, `apps/worker/src/main.ts`
  registers two BullMQ **repeatable jobs** on the `automation` queue with stable
  `jobId`s: `sweep` every 60s and `retry-sweep` every 30s (`registerSchedules()`).
- Running multiple worker replicas is safe: the repeatable-job registration is
  idempotent (keyed `jobId`), and each fired tick is claimed exactly once via
  `AutomationRun @@unique([automationRuleId, scheduledFor])`.
- Nothing to configure — just run the worker. If you later move scheduling to a
  platform cron, disable `registerSchedules()` and have cron enqueue
  `{ type: 'sweep' }` / `{ type: 'retry-sweep' }`.

## 16. Monitoring

1. **Logs:** both images log pino JSON to stdout (`LOG_LEVEL=info`, no pretty in
   prod). Ship to the platform's log store / Loki; the compose file rotates
   json-file logs (10 MB × 5).
2. **Metrics + alerts:** the prod compose bundles Prometheus + Alertmanager
   behind a profile — `docker compose -f docker-compose.production.yml --profile
monitoring up -d`. Prometheus scrapes `web:/api/metrics` (bearer `METRICS_TOKEN`,
   put it at `./.secrets/metrics_token`) and `worker:9090/metrics`, loads
   `deploy/alerts.yml`, and forwards to Alertmanager. **`deploy/alertmanager.yml`
   ships with a NULL receiver — replace it with a real Slack/PagerDuty receiver
   and point the routes at it before you rely on alerting.** (Or run a hosted
   Prometheus/Grafana Cloud instead and just expose the two endpoints.)
3. **Errors:** server faults fold into de-duplicated `ErrorEvent` rows at
   `/admin/errors`. **Client-side and edge-runtime errors** also land there —
   the browser and `instrumentation.ts` POST them to `/api/client-error`. No
   Sentry integration exists (planned only); `SENTRY_DSN` is read by nothing.
4. **Dashboards:** `/admin/system-health` (platform-staff only) shows the ten
   operational metrics + `pg_stat_*` + the worker fleet; use it as the
   first-look during an incident.
5. **CDN:** front the app with a CDN and cache `/_next/static/*` and `/public/*`
   (Caddy already stamps `immutable`); leave `/app`, `/admin`, `/api`, `/r`
   uncached.
6. **Uptime:** an external monitor on `https://<APP_DOMAIN>/api/health` every
   60s, alerting on non-200 or `status:"down"`.

## 17. Rollback

1. **App code:** redeploy the previous image tag for `web`, then `worker`. Both
   are stateless; sessions are JWTs and survive.
2. **Because migrations are expand/contract**, the previous app version runs
   against the new schema — so a code rollback needs **no schema rollback**.
3. If a migration itself is bad: restore from the pre-migration backup into a
   new database (`deploy/backup/pg-restore.sh`), repoint `DATABASE_URL` /
   `DIRECT_URL`, redeploy. Never hand-edit a live schema under pressure.
4. **Kill switches** for partial mitigation without a full rollback:
   `CRAWLER_HALT=1` (stop all crawls), pause a BullMQ queue from `/admin/jobs`,
   or unset an AI key to force deterministic mode.
5. Post-incident: write it up within 5 business days (`docs/SECURITY.md` §15
   IR outline) and add a regression test.

## 18. Disaster recovery

Added Phase 31 (final security review) — no prior phase had reviewed this.
`docs/SECURITY.md` §15's incident-response outline covers _security_
incidents (a leaked key, a tenant-isolation bug); this section covers
_infrastructure loss_ — the VPS dies, or the managed Postgres/Redis provider
has an outage. Two things worth naming plainly rather than leaving implicit:

**The architecture has an accepted single point of failure.**
`docker-compose.production.yml` runs `web` and `worker` on **one host** by
design (its own header comment calls this out) — Postgres/Redis/email are
managed and separately resilient, but the compute itself is not
multi-host or multi-region. This is a deliberate scope choice appropriate
for the current stage (see `docs/PRODUCT.md`/`docs/ROADMAP.md`, which both
scope multi-region as a later/Enterprise item), not an oversight — but it
had never been written down as an _accepted_ risk anywhere a reviewer would
look for it. It is now: **accepted for the current stage; revisit before
any SLA commitment that implies multi-host resilience.**

**Realistic RTO/RPO given the actual backup setup:**

- **RPO (data loss window):** bounded by whichever is smaller — the managed
  Postgres provider's point-in-time recovery (continuous, effectively
  seconds-to-minutes) or `pg-backup.sh`'s own cadence if you're restoring
  from the portable copy instead (run it hourly-to-every-6-hours per the
  cron example in the script's header; RPO equals that interval).
- **RTO (time to restore service):** dominated by provisioning a new VPS +
  redeploying the two containers (`docker compose -f
docker-compose.production.yml up -d` after `run --rm migrate`, minutes
  once DNS points at it) plus, if the database itself was lost, a
  `pg-restore.sh` run against the latest backup (`deploy/backup/pg-restore.sh`'s
  own runtime scales with dump size — untested at production data volumes
  in this repo, so treat any specific number as a guess until a real drill
  measures it).

**Scenario runbooks:**

1. **The VPS dies** (hardware failure, provider outage, accidental
   deletion): provision a replacement, clone this repo, restore
   `.env.production` from wherever it's actually kept (the platform secret
   store — it does not live on the dead host by design), point DNS at the
   new IP, run §13-§15 (build → migrate → start) unchanged. Postgres/Redis
   are unaffected (managed, separate hosts) — only compute was lost.
2. **The managed Postgres provider has an outage**: check the provider's
   status page and SLA first — most outages resolve without action. If a
   genuine, prolonged loss: restore the latest `pg-backup.sh` dump
   (`pg-restore.sh`) into a _new_ Postgres instance (a different provider if
   needed), repoint `DATABASE_URL`/`DIRECT_URL`, redeploy `web`+`worker`.
   Data since the last backup is lost — this is exactly the RPO tradeoff
   above; a shorter cron interval buys a smaller window at the cost of more
   frequent dump/upload load.
3. **The managed Redis provider has an outage**: no separate runbook needed
   — the rate limiter and health check already fail open/degrade gracefully
   by design (`packages/services/src/security/rate-limit.ts`); BullMQ queues
   stall until Redis returns (jobs queue up, nothing is lost, no data-loss
   risk). Restore is automatic once the provider recovers.

**Restore procedure status, honestly:** `pg-restore.sh` is a real,
reasonable script (checksum verification, decrypt, `pg_restore --clean
--if-exists`, targets a scratch DB, never the live one) and its own header
says to test it quarterly — but there is no evidence in this repo (no CI
job, no logged drill) that it has ever actually been executed end-to-end.
**Treat it as unverified until a real restore drill happens once** — this
is the single most important gap a "final" review found in this area: a
backup you have never restored is a hope, not a plan.
