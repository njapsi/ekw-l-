# STAGING.md — Staging Deployment Runbook

**What this document is:** the exact, step-by-step process to stand up a real,
internet-reachable staging environment for Growth Agent — a full rehearsal of
`docs/DEPLOYMENT.md`'s production process, using disposable/test-mode
credentials everywhere a provider offers them. It is written to be followed
literally, top to bottom, by whoever holds the actual hosting/domain/
third-party developer accounts.

**What this document is not:** a record of a staging environment this Claude
Code session actually created. It didn't, and couldn't — this session has no
cloud account, no domain, no Google/TikTok/Stripe/email-provider credentials,
and no way to create any of those (see "Why this is a runbook, not a
deployment" below). Every command in this file is meant to be run by a human
with that access; none of them were run against real infrastructure while
writing it.

---

## Why this is a runbook, not a deployment

Phase 30's brief asks to "prepare and deploy a complete staging environment."
Actually deploying one requires, at minimum: a VPS or cloud account, a
registered domain with DNS you control, a Supabase project, an Upstash
database, a Google Cloud project, a TikTok developer account, a Stripe
account, and (optionally) an email-provider account and an AI-provider API
key. This session has zero access to any of that — no cloud CLI is installed,
no credentials exist in the environment, and nothing here can create an
account, register a domain, or mint a real OAuth/API credential on your
behalf. Handed a choice between fabricating a "staging is live" narrative and
being explicit about the gap, this document does the latter: it is the
complete, concrete, copy-pasteable process for someone who does have that
access, checked against this codebase's actual code (env validation rules,
route paths, compose files) rather than written from general deployment
knowledge.

**Staging vs. production, precisely:** staging runs the _same_ Docker images,
the _same_ `NODE_ENV=production`, and the _same_ strict env validation as
production (`docs/DEPLOYMENT.md`) — it is meant to catch exactly the class of
bug that only shows up under production-like conditions. The only deliberate
differences are: smaller/cheaper infrastructure, **Stripe TEST mode instead of
live** (hard requirement — never a `sk_live_`/`pk_live_` value in
`.env.staging`), OAuth apps left in "Testing" mode (no Google verification,
no TikTok audit — both gate only specific things, detailed per-integration
below), and a disposable database you can freely reset.

---

## Architecture

Same two-container model as production (`docs/DEPLOYMENT.md` "Architecture",
ADR-0031): a `web` container (Next.js standalone) and a `worker` container
(BullMQ + Playwright Chromium), both stateless, both built from the
`Dockerfile.web`/`Dockerfile.worker` already in this repo — no Dockerfile
changes for staging. What's different is _where the managed services live_:

| Requirement    | Production (`docs/DEPLOYMENT.md`)       | Staging (this document)                                                              |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| Compute        | Any container platform, ≥2 web replicas | **One small VPS**, docker-compose, 1 replica each                                    |
| Postgres       | Neon / RDS / Cloud SQL                  | **Supabase** (generous free tier, pooled + direct connection strings out of the box) |
| Redis          | Upstash / ElastiCache / MemoryDB        | **Upstash** (same choice — free tier is enough for staging traffic)                  |
| Object storage | R2 / S3                                 | **N/A — see "Object storage" below**                                                 |
| Payments       | Stripe live mode                        | **Stripe TEST mode**                                                                 |
| TLS            | Platform TLS or Caddy                   | **Caddy auto-TLS** (`docker-compose.staging.yml`, new this phase)                    |
| Env file       | `.env.production` (secret store)        | **`.env.staging`** (new template this phase: `.env.staging.example`)                 |

New files this phase: `docker-compose.staging.yml` (a deliberate near-
duplicate of `docker-compose.production.yml` — see that file's header comment
for the exact, exhaustive list of differences) and `.env.staging.example`
(mirrors `.env.example`, annotated for staging specifics).

---

## Prerequisites checklist

Before starting, have (or be ready to create) accounts for:

- [ ] A VPS or equivalent (any provider — DigitalOcean, Hetzner, a spare AWS
      EC2 instance, etc.) — Docker + Docker Compose installed, ports 80/443
      open.
- [ ] A domain you control, with DNS access, for a staging subdomain (e.g.
      `staging.your-domain.example`).
- [ ] A [Supabase](https://supabase.com) account (free tier is enough).
- [ ] An [Upstash](https://upstash.com) account (free tier is enough).
- [ ] A [Google Cloud](https://console.cloud.google.com) account/project.
- [ ] A [TikTok for Developers](https://developers.tiktok.com) account.
- [ ] A [Stripe](https://dashboard.stripe.com) account (Test mode needs no
      separate signup — it's a toggle on any Stripe account).
- [ ] Optional: a [Resend](https://resend.com) account (magic-link email) —
      skip and use `EMAIL_TRANSPORT=console` if you don't need real email yet.
- [ ] Optional: an Anthropic or OpenAI API key (the app runs deterministically
      with none — no AI feature is required for the rest of this checklist to
      pass).

---

## 0. Pre-flight — verify the code before shipping it anywhere

Run this from the repo root, on a machine with Postgres/Redis reachable (or
via the existing `docker-compose.yml` dev stack):

```bash
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test                              # unit
pnpm test:scripts                      # scripts/check-env.mjs's own contract
```

All of this must be green before building images for staging — staging is
meant to catch _infrastructure_ problems, not code problems the existing test
suite already covers.

## 1. Domain & DNS

1. Pick the staging host, e.g. `staging.your-domain.example`. Don't reuse the
   production hostname — `AUTH_URL`/`NEXT_PUBLIC_APP_URL`/`APP_DOMAIN` must all
   be this exact `https://` origin (the app trusts the `Host` header for OAuth/
   magic-link redirects, `docs/SECURITY-AUDIT.md` I-2), so a shared hostname
   between environments would let staging traffic look like production's.
2. Create an `A` (or `AAAA`) record pointing that subdomain at the VPS's IP.
   Caddy (below) issues its own Let's Encrypt certificate once this resolves —
   nothing to configure for TLS beyond DNS being correct.
3. Confirm propagation: `dig +short staging.your-domain.example` returns the
   VPS IP before continuing.

## 2. Provision the VPS

1. Any small VPS (1-2 vCPU / 2-4 GB RAM is enough for staging traffic) running
   a recent Linux distribution.
2. Install Docker + the Compose plugin (`docker compose version` should work).
3. Clone this repository onto the VPS (or ship the built images to it via a
   registry — either works with the compose file below; cloning is simplest
   for a single staging box).
4. Open inbound TCP 80 and 443 in whatever firewall/security-group the VPS
   provider uses (Caddy needs both — 80 for the ACME HTTP challenge, 443 for
   the actual TLS traffic).

## 3. Database — Supabase

1. [supabase.com](https://supabase.com) → New project. Pick a region close to
   the VPS.
2. Project Settings → Database → **Connection string**. Supabase gives you two
   distinct strings on the same project — use both, they are not
   interchangeable:
   - **Transaction pooler** (port 6543, `?pgbouncer=true`) → `DATABASE_URL`.
     This is what the running app uses for every query.
   - **Direct connection** (port 5432) → `DIRECT_URL`. Prisma migrations need
     an unpooled connection; this is only used by the one-shot `migrate`
     step below, never by the running app.
3. Nothing else to configure — Supabase's managed Postgres is already 16.x
   and already has automated backups/PITR on by default.

## 4. Redis — Upstash

1. [upstash.com](https://upstash.com) → Create database → Regional (pick a
   region close to the VPS) → **TLS enabled** (the default).
2. Copy the `rediss://` connection string it gives you → `REDIS_URL`.
3. Nothing else to configure. The app's rate limiter fails open if Redis is
   briefly unreachable, so a blip on the free tier won't lock out sign-in —
   still worth confirming the queue/rate-limit paths work end to end (§13).

## 5. Object storage

**There is nothing to configure here that the application itself will use.**
`packages/services` has no code path that reads `S3_ENDPOINT` / `S3_BUCKET` /
`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` — confirmed in `.env.example`'s
"NOT IMPLEMENTED" section and `docs/FORENSIC-AUDIT.md`. Reports render
on-demand from the database; nothing is uploaded anywhere. Setting these
variables would not be a lie exactly, but it would imply a feature exists that
doesn't, so `.env.staging.example` leaves them unset with a comment explaining
why.

The one place object storage is genuinely useful on staging is the **Postgres
backup script** (`deploy/backup/pg-backup.sh`), which is real, working
tooling, separate from the app's own (unimplemented) object-storage feature.
If you want a portable backup independent of Supabase's own PITR: create a
Cloudflare R2 bucket (or use Supabase Storage's own S3-compatible endpoint,
Project Settings → Storage → S3 Connection), and set `BACKUP_S3_BUCKET` /
`BACKUP_S3_ENDPOINT` in `.env.staging`. This is optional — skip it if staging
data is disposable, which it usually is.

## 6. AI provider

Optional. Every AI-touching code path (the analyst agents, the Growth Agent
orchestrator, content generation) has a deterministic fallback, so staging is
fully exercisable with **no** AI key at all — you'll just get keyword-routed,
template-based output instead of model-generated narrative. If you want the
real experience:

1. Get an API key from [Anthropic](https://console.anthropic.com) or
   [OpenAI](https://platform.openai.com).
2. Set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in `.env.staging`.
3. AI providers have no "test mode" distinct from production — this is a real
   key against the real API, billed at the same rates. Consider a low
   spend-limit key scoped just to staging, and watch usage; Phase 22's
   per-user throttle (`AI_USER_RATE_LIMIT`) and per-org budget enforcement
   (Phase 23) apply on staging exactly as they do in production.

## 7. Google OAuth — YouTube + Search Console + "Sign in with Google"

One Google Cloud OAuth client serves all three (confirmed in
`packages/services/src/auth/providers.ts` — the sign-in provider and the
integration flows read the same `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`).

1. Google Cloud Console → **APIs & Services → Enabled APIs** → enable
   _YouTube Data API v3_, _YouTube Analytics API_, and _Search Console API_.
2. **OAuth consent screen** → External → fill in app name/support email →
   add scopes `youtube.readonly`, `yt-analytics.readonly`,
   `webmasters.readonly`, `openid`, `userinfo.email`. **Leave it in Testing
   mode** — staging doesn't need Google's sensitive-scope verification (which
   takes days-to-weeks for production); Testing mode works immediately for up
   to 100 explicitly-added test users. Add your own and your QA team's Google
   accounts under **Test users**.
3. **Credentials → Create OAuth client ID → Web application.** Add **both**
   redirect URIs (one client, two consumers):
   - `https://staging.your-domain.example/api/auth/callback/google`
     (NextAuth's own sign-in callback)
   - `https://staging.your-domain.example/api/integrations/google/callback`
     (the YouTube/Search Console connect flow)
4. Copy the Client ID/Secret → `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` in `.env.staging`.
5. Add `staging.your-domain.example` under **Authorized domains** on the
   consent screen.

## 8. TikTok developer app

1. [developers.tiktok.com](https://developers.tiktok.com) → create an app.
   Add **Login Kit** and **Display API**.
2. Redirect URI: `https://staging.your-domain.example/api/integrations/tiktok/callback`.
   Scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`,
   `video.list`.
3. **An unaudited (sandbox) app is fine for staging** — everything above
   works without TikTok's audit. Only `video.publish` (real posting) and
   posting anything other than `SELF_ONLY` (private) videos need an audited
   app; skip requesting that scope for staging unless you specifically need
   to test publishing.
4. Copy the Client Key/Secret → `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`.

## 9. Stripe — TEST MODE ONLY

**Do not use production payment credentials — this is a hard requirement.**
Everything in this section uses Stripe's Test mode, a toggle in the top-right
of the Stripe Dashboard, not a separate account. Test-mode keys, Price IDs,
and webhook signing secrets are entirely separate from live-mode ones even
within the same Stripe account — switch the toggle before doing anything
below and stay on it.

1. Dashboard (Test mode) → Products → create CREATOR / PRO / AGENCY, each with
   a monthly and yearly recurring Price (6 Price IDs total). The app never
   hard-codes an amount — display prices live in
   `packages/services/src/billing/plans.ts`; only the Price IDs are env.
2. Developers → API keys (Test mode) → copy the **Secret key** (`sk_test_...`)
   and **Publishable key** (`pk_test_...`).
3. Developers → Webhooks → Add endpoint →
   `https://staging.your-domain.example/api/billing/webhook`, events
   `checkout.session.completed`, `customer.subscription.*`, `invoice.*`. Copy
   the **signing secret** (`whsec_...`) — this is a per-endpoint value,
   separate from the API key.
4. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and the six `STRIPE_PRICE_*` ids in
   `.env.staging` — all six prices are all-or-nothing (`check-env.mjs`
   enforces this).
5. Settings → Billing → Customer portal → enable it (so `changePlan`/`cancel`
   can hand off, exactly as in production).
6. **Before deploying**, grep the assembled file for a live-mode value as a
   last check: `grep -E 'sk_live_|pk_live_' .env.staging` must print nothing.

## 10. Email

Pick one:

- **Real magic-link email** (recommended if you want to test the actual
  sign-in flow a user would experience): [Resend](https://resend.com) → create
  an API key → `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY=re_...`. Verify the
  sending domain in Resend's dashboard (SPF/DKIM) if you want mail to land in
  a real inbox rather than spam.
- **Console only** (fine if Google sign-in already covers your test accounts):
  `EMAIL_TRANSPORT=console` — magic-link URLs print to the `web` container's
  logs (`docker compose -f docker-compose.staging.yml logs web`) instead of
  being sent. Note `check-env.mjs` only accepts this on staging because Google
  OAuth (§7) provides the required "at least one sign-in path."

## 11. Assemble `.env.staging`

1. `cp .env.staging.example .env.staging` on the VPS (or wherever you're
   building from) — **never commit this file** (already gitignored).
2. Generate the two secrets:
   ```bash
   openssl rand -base64 32   # → AUTH_SECRET
   openssl rand -base64 32   # → ENCRYPTION_KEY (use a DIFFERENT value than production's)
   ```
3. Fill in every value from steps 1-10 above.
4. Validate — this prints variable names and pass/fail only, never a value:
   ```bash
   node scripts/check-env.mjs --file .env.staging --target all
   ```
   Fix everything it flags before continuing. Expect it to pass with the
   real HTTPS staging domain — **do not** pass `--allow-insecure` (that flag
   exists for a staging deployment with no TLS at all; this runbook configures
   real HTTPS via Caddy, and Google/TikTok OAuth callbacks require a real
   HTTPS redirect URI regardless, so there's no scenario here where it's
   needed). Also do **not** set `GROWTH_AGENT_ENV_STRICT=0` — that escape
   hatch exists for automated e2e test boots (`docs/E2E-TESTING.md`), and
   using it here would mean staging isn't actually rehearsing production's
   boot validation, defeating the point of a staging environment.

## 12. Build and ship the images

From the repo root (on the VPS, if building there):

```bash
docker compose -f docker-compose.staging.yml build
```

(Or build in CI and push to a registry, then pull on the VPS — either works;
the compose file references plain image names/tags either way.)

## 13. Run database migrations

**Never at container boot** — same rule as production
(`docs/DEPLOYMENT.md` §12). One-shot release step, against `DIRECT_URL`:

```bash
docker compose -f docker-compose.staging.yml run --rm migrate
```

This runs `prisma migrate deploy` (only applies pending migrations, safe to
re-run, never resets). Confirm it exits 0 before starting the app.

## 14. Start web + worker + Caddy

```bash
docker compose -f docker-compose.staging.yml up -d
docker compose -f docker-compose.staging.yml ps         # both healthy
docker compose -f docker-compose.staging.yml logs -f    # watch boot logs
```

Caddy requests its Let's Encrypt certificate automatically on first request to
the domain — give it a minute, then confirm `https://staging.your-domain.example`
loads with a valid certificate (no browser warning).

## 15. Scheduled jobs — nothing extra to start

The worker registers its own repeatable BullMQ ticks (`registerSchedules()`,
`apps/worker/src/main.ts`) the moment it boots — the automation engine's
60-second sweep and 30-second retry-sweep (Phase 12) start automatically as
part of step 14, with no separate cron/scheduler process to configure. There
is no cron job to add on the VPS itself.

---

## Verification

Run every one of these against the real staging URL. Where a step needs a
browser and a real Google/TikTok account, it's marked **(manual)** — that step
needs a human, not a script.

### `/api/health`

```bash
curl -s https://staging.your-domain.example/api/health | jq .
```

Expect HTTP 200 (always, per `docs/OBSERVABILITY.md` — the endpoint's own
contract) with a body like `{"status":"ok","checks":[...]}`. Every check in
the array (`database`, `redis`, `ai_provider`, `external_integrations`,
`worker`) should read `ok` or `unconfigured` — never `down`. If `database` or
`redis` show `down`, stop here and fix connectivity before verifying anything
downstream (Phase 28 confirmed both are now individually timeout-bounded, so
a `down` here means a real connectivity problem, not a hang).

### Background jobs

```bash
curl -s https://staging.your-domain.example/api/health | jq '.checks[] | select(.name=="worker")'
```

Then **(manual)**, sign in as platform staff and check `/admin/jobs` — queue
depths for all 8 queues should show `0` (idle) rather than an error, and
"Repeatable ticks" should list the automation sweep/retry-sweep registered in
step 15 with a recent next-run time. `/admin/system-health` should show a
fresh `WorkerHeartbeat` (< ~30s old).

### OAuth callbacks **(manual)**

For each of YouTube, TikTok, and Search Console: sign in to the staging app,
go to `/app/integrations/{youtube,tiktok,search-console}`, click Connect, and
confirm you land on the real provider's consent screen (not an error page),
approve with a test account added in §7/§8, and get redirected back to a
"connected" state — not an error banner. Also confirm "Sign in with Google" on
`/login` completes a full session (proves the same OAuth client's second
redirect URI from §7 is wired correctly).

### Webhooks

```bash
stripe trigger checkout.session.completed --api-key sk_test_...
```

(Or use the Dashboard's "Send test webhook" button on the endpoint from §9.)
Confirm the request lands as a 200 in Stripe's webhook log, and that
`/admin/subscriptions` (or the org's `/app/billing`) reflects the resulting
state change — proves the endpoint verifies the signature and processes the
event, not just that it's reachable.

### Crawler

**(manual, but scriptable if you have a session cookie)**: `/app/seo` → add a
website → verify ownership (DNS TXT or the `.well-known` file the UI shows) →
start a crawl against a real, small public site (or your own staging landing
page). Confirm the crawl reaches `COMPLETED` and the issues list renders. This
exercises the full SSRF-safe fetch pipeline against real network egress from
the VPS, which nothing in local development can substitute for.

### AI

If an AI key was configured (§6): `/app/agent`, ask a question, confirm a
streamed model response with a rationale (not the deterministic fallback
text). If no key was configured: confirm the deterministic path still
produces a coherent, non-error response — this is the expected, correct
behavior with no key, not a failure.

### Billing

Full test-mode checkout: `/app/billing` → choose a plan → complete Stripe
Checkout using [a Stripe test card](https://stripe.com/docs/testing)
(`4242 4242 4242 4242`, any future expiry/CVC) → confirm the webhook from
above fires, the org's `Subscription`/`Entitlement` rows update, and
`/app/billing` reflects the new plan. Then cancel and confirm the
cancel-at-period-end path also updates correctly.

---

## Rollback / teardown

- **Roll back a bad deploy:** `docker compose -f docker-compose.staging.yml
up -d --no-deps web worker` with the previous image tag (`IMAGE_TAG=<prior
sha>`) — migrations are additive/forward-only (same rule as production,
  `docs/DEPLOYMENT.md` §12), so the previous image version keeps working
  against the current schema.
- **Reset staging data:** since staging Postgres is disposable, the simplest
  "reset" is dropping and recreating the Supabase project's schema, then
  re-running step 13 — there is no production data to protect here.
- **Tear down entirely:** `docker compose -f docker-compose.staging.yml down
-v` on the VPS, delete the Supabase project, the Upstash database, and the
  DNS record; the Google/TikTok apps and Stripe test-mode config can be left
  in place for the next staging cycle at no cost.

---

## What this phase actually delivered

- `docker-compose.staging.yml` — a staging-specific compose file (Caddy
  auto-TLS, smaller resource limits, `.env.staging`-driven).
- `.env.staging.example` — the annotated env template for everything above.
- This document.

**Not delivered, and not possible from this session:** an actual running
staging deployment, a real domain, real Supabase/Upstash projects, real
Google/TikTok OAuth apps, or a real Stripe test-mode configuration — all of
that requires accounts and access this sandboxed environment does not have.
Follow the steps above with real access to make staging operational.
