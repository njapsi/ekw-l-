# Growth Agent

Production SaaS: an AI-powered growth agent for YouTube/TikTok creators, website
owners, SEO professionals, and agencies. It turns connected analytics and
website crawl data into prioritized, **explainable** recommendations — with no
fabricated metrics and no guaranteed outcomes.

> Full product spec: `Claude Code Master Project Instruction.pdf`. Development
> rules: [`CLAUDE.md`](./CLAUDE.md). Design docs: [`docs/`](./docs).

## Monorepo

| Path                     | What                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `apps/web`               | Next.js 15 (App Router) — public site, app, admin, API.     |
| `apps/worker`            | BullMQ worker — crawls, agent runs, report generation.      |
| `packages/core`          | Domain types, Zod schemas, agent + orchestration contracts. |
| `packages/ai`            | Provider-agnostic AI layer (Anthropic / OpenAI / Google).   |
| `packages/db`            | Prisma schema, client, migrations, seed, repositories.      |
| `packages/services`      | Business logic per module (auth, rbac, organizations, …).   |
| `packages/ui`            | Radix-based accessible component system + Tailwind preset.  |
| `packages/observability` | pino logger + request-correlation helpers.                  |

Full design: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Prerequisites

- Node.js ≥ 20.11 (`.nvmrc`)
- pnpm ≥ 10
- Docker (for local Postgres / Redis / MinIO / Mailpit via `docker-compose.yml`)

## Setup

```bash
docker compose up -d
cp .env.example .env                       # defaults already match docker-compose
pnpm install
pnpm db:generate
pnpm --filter @growth-agent/db migrate:deploy
pnpm --filter @growth-agent/db seed        # owner@example.com + member@example.com
pnpm dev                                   # http://localhost:3000
```

Sign in with the magic link (printed to the server console in dev), or use the
**Dev sign-in** button with a seeded address while `AUTH_DEV_LOGIN=true`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @growth-agent/db test:integration
pnpm --filter @growth-agent/web test:e2e
```

## Status

- Phase 0 — scaffold ✅
- Phase 1 — product architecture ✅
- Phase 2 — web application foundation ✅ (auth, RBAC, tenancy, app shell)
- YouTube growth agent ✅ — Google OAuth (read-only, encrypted tokens),
  incremental channel/video/analytics sync, the YouTube Analyst Agent with a
  grounding check, and the `/app/youtube/*` dashboard incl. a 4-section
  Monetization page. See [`docs/YOUTUBE-INTEGRATION.md`](./docs/YOUTUBE-INTEGRATION.md).
- TikTok growth agent ✅ — Login Kit OAuth + PKCE, Display API account/video
  sync, the TikTok Analyst Agent, and **authorized publishing** via the Content
  Posting API (explicit approval, duplicate guard, audit). API limitations in
  [`docs/TIKTOK-INTEGRATION.md`](./docs/TIKTOK-INTEGRATION.md).
- Technical SEO crawler ✅ — a bounded, robots-aware, **SSRF-safe**
  (resolve-then-pin DNS, IP-range blocking, per-redirect re-validation) crawl →
  extract → link-graph → auditor pipeline. ~39 rules across 9 categories,
  category scores with transparent weighting, ownership verification, a kill
  switch, and a grounded SEO Auditor Agent. Design + limitations in
  [`docs/SEO-ENGINE.md`](./docs/SEO-ENGINE.md).
- AI SEO Agent ✅ — reasons over the stored crawl data through **nine restricted
  read-only tools** (no write path), ranks fixes with a transparent six-factor
  priority score, builds Quick Wins / High Impact / Technical Projects /
  Long-Term action plans, answers free-form questions, and scores machine
  readability (established vs experimental guidance). Deterministic core; the
  model only refines wording and is dropped if it can't be grounded. See
  [`docs/SEO-ENGINE.md`](./docs/SEO-ENGINE.md) §6.
- Unified AI Growth Agent ✅ — one chat at `/app/agent` that plans which
  specialists to run across YouTube / TikTok / SEO, gathers evidence, and
  returns a grounded structured answer (analysis summary · evidence · decisions
  · recommendations · actions) — **no chain-of-thought exposed**. Streaming,
  conversation history / search / export, controlled memory (goals, preferences,
  completed tasks — secret-redacted), and recommendations → tasks. It never
  changes an external account; external actions are proposed for you to confirm
  in that platform's own screen. Works with or without an AI key.
- Content repurposing engine ✅ — one piece of source content →
  analysis → key ideas → angles → **13 platform deliverables** (titles,
  descriptions, chapters, Shorts/TikTok ideas + captions, hooks, scripts, social
  posts, blog ideas, SEO outlines, FAQs, newsletter angles). Every piece is an
  editable draft with immutable version history; status flows draft → approved →
  scheduled/published/failed with a full audit trail. The engine never
  publishes and never scrapes or transcribes — you provide the transcript. See
  [`docs/CONTENT-REPURPOSING.md`](./docs/CONTENT-REPURPOSING.md).
- Monetization intelligence engine ✅ — turns your connected data and a
  business profile you fill in into a **ranked list of monetization channels**
  (platform monetization, sponsorships, affiliates, digital products, services,
  memberships, subscriptions, lead generation, consulting, courses, brand
  partnerships). Every opportunity shows evidence, audience fit, estimated
  difficulty, estimated potential, required actions and confidence — all
  **labelled estimates, never dollar amounts**. It never claims you qualify for
  a platform program (the platform decides), and revenue tracking shows only
  figures you enter yourself, with a monthly history. See
  [`docs/MONETIZATION.md`](./docs/MONETIZATION.md).
- Billing & usage ✅ — Stripe subscriptions with **configuration-based plans**
  (Free / Creator / Pro / Agency / Enterprise — prices and limits live in one
  catalog, not scattered through the code): Checkout, Billing Portal, upgrades /
  downgrades / cancellation, invoices, and **signature-verified, idempotent**
  webhooks. Usage is metered (AI requests & tokens, crawls & crawl pages,
  connected accounts, content generations, seats) and limits are enforced
  **server-side** — the browser is never trusted for billing. Stripe holds all
  card data; the app stores none. Runs without Stripe configured (everyone Free,
  limits still enforced). See [`docs/BILLING.md`](./docs/BILLING.md).
- Reporting engine ✅ — a professional report for YouTube, TikTok, SEO, website
  health, AI recommendations, growth and monetization, each with the same seven
  sections (executive summary, key metrics, problems, opportunities,
  recommendations, priority actions, historical changes). View it as a
  dashboard, export to **PDF / CSV / JSON**, or create a **shareable link** —
  the public view is redacted (no account identifiers, no private figures) and
  every report is an **immutable snapshot**, so historical reports never change.
  See [`docs/REPORTING.md`](./docs/REPORTING.md).
- Automation engine ✅ — schedule analyses and reports to run automatically
  (daily / weekly / monthly / custom cron): "analyze my YouTube channel every
  Monday", "crawl my website every week", "send me my weekly growth report",
  "tell me when a critical SEO issue appears". A worker sweep runs each rule on
  schedule with **retry + exponential backoff + idempotency**, keeps an
  execution log, and re-checks the owner's permissions on every run — an
  automation can never exceed its owner's access and never publishes anything
  externally. See [`docs/AUTOMATION.md`](./docs/AUTOMATION.md).
- Admin & observability ✅ — an internal **`/admin`** console (platform staff
  only, read-only): users, organizations, subscriptions, usage, AI usage, agent
  runs, crawler jobs, API integrations, errors, audit logs, system health and
  background jobs. Operational metrics (request latency, error rate, API / AI
  failures, AI tokens + cost, crawler failures, queue depth, job duration,
  database performance) as a Prometheus endpoint plus database-derived
  dashboards; structured logs with correlation ids; health checks for the
  database, Redis, the AI provider and external integrations. No secrets are
  ever shown. See [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md).

Outstanding: auth & tenancy hardening (RLS, rate limits, a tier-enforcement edge
layer), recommendation/task/notification UI, the general model-driven
orchestrator + remaining agents, SEO raw-HTML archiving, OpenTelemetry tracing +
pushed alerts. See [`docs/ROADMAP.md`](./docs/ROADMAP.md).
