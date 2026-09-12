# PRODUCT.md

Growth Agent is a production, multi-tenant SaaS that turns a creator's or site
owner's connected analytics and website crawl data into **prioritized,
explainable growth actions**. It never fabricates metrics and never promises
guaranteed outcomes (monetization approval, revenue, or search rankings).

---

## 1. Target users

| Segment                           | Who they are                            | Primary need                                                     | Willingness to pay |
| --------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | ------------------ |
| **Solo YouTube creator**          | 1k–500k subs, part- or full-time        | "Am I close to monetization? What should I make next?"           | Low–medium         |
| **Solo TikTok creator**           | Growing, cross-posts to other platforms | Caption/hashtag/idea help, posting cadence, repurposing          | Low–medium         |
| **Website / blog owner**          | Owns 1–5 content sites                  | Technical SEO issues found and explained in plain language       | Medium             |
| **SEO professional / freelancer** | Manages 5–30 client sites               | Fast technical audits, exportable client-ready reports           | Medium–high        |
| **Agency**                        | 10–200 client properties, a team        | Multi-seat, per-client workspaces, white-labelled reports, roles | High               |
| **Business / in-house team**      | Marketing + web team                    | One place for channel + site growth, audit trail, SSO            | High               |

Buyer vs. user: for agencies and businesses the **buyer** is an owner/admin who
cares about seats, isolation, and billing; the **users** are analysts and
editors who care about the workflow.

---

## 2. Core problems

1. **Data is scattered and raw.** YouTube Studio, TikTok, Search Console, and a
   dozen SEO tools each show fragments. Nobody synthesizes them into "do this
   next".
2. **Advice is generic.** Blog posts and most tools give checklists, not
   decisions grounded in _your_ numbers.
3. **Technical SEO is opaque.** Site owners can't tell a canonical conflict from
   a redirect chain, or judge which issue actually matters.
4. **Recommendations aren't trustworthy.** Users can't see _why_ a tool says
   something, what evidence it used, or how confident it is.
5. **Monetization readiness is a guessing game.** Creators don't know how far
   they are from program thresholds or what's blocking them.

---

## 3. Core features

Grouped by module (see `ARCHITECTURE.md`).

- **AI Growth Agent** — conversational + task-based. Reasons over connected
  analytics, crawl data, SEO findings, historical trends, and stated goals.
  Emits `findings → explanations → priorities → recommended actions →
implementation instructions → expected impact → confidence → evidence`.
  Every statement tagged `fact | calculated_metric | assumption | prediction |
recommendation`.
- **YouTube analysis** — connect account; channel + video performance; title,
  description, topic, and publishing-pattern analysis; high/low performers;
  content-opportunity gaps; KPI tracking and trend detection; monetization-
  readiness assessment (estimate, never a guarantee).
- **TikTok analysis** — connect via official API; analyze available
  profile/video data and posting patterns; generate captions, hashtags, ideas;
  recommend repurposing; support authorized publishing only where permitted.
- **Technical SEO engine** — crawl a site; evaluate status codes, redirects,
  canonicals, robots, sitemaps, indexability, internal linking, duplicates,
  structured data, metadata, rendering (SSR/CSR/JS), Core Web Vitals where
  measurable, crawl/URL depth, soft 404s, HTTPS/mixed content, mobile
  rendering, semantic HTML. Produce ranked issues with fixes.
- **Content opportunities & ideas** — gap analysis across a creator's catalogue
  and (where permitted) public competitor context.
- **Recommendations** — normalized, explainable, with an approval state.
- **Reports** — _implemented (operator's "Phase 11")._ Seven report types, each
  with the same seven sections; dashboard view + PDF/CSV/JSON export + redacted
  public share links; immutable snapshots so historical reports never change
  (`docs/REPORTING.md`). White-labelling is post-MVP.
- **Tasks** — recommendations promoted to trackable work items with status.
- **Integrations** — OAuth connections (YouTube/Google, TikTok, Google Search
  Console) with health and scope visibility.
- **Notifications** — in-app + email for completed crawls, agent runs, metric
  changes, approvals needed.
- **Dashboard** — per-organization overview: KPIs, recent runs, open
  recommendations, integration health.
- **Admin** — platform-staff console: users, organizations, subscriptions,
  usage, API health, background jobs, errors, audit logs, abuse monitoring.

---

## 4. Primary user journeys

### J1 — Creator onboarding to first insight

Sign up → create/confirm organization → connect YouTube → initial data sync
(background job) → dashboard populates → open "Monetization readiness" → agent
returns findings + ranked recommendations with evidence → user promotes two to
Tasks.

### J2 — Site owner technical audit

Sign up → add SEO Project with root URL → verify ownership (DNS/HTML file/GSC) →
start crawl (bounded) → crawl completes (notification) → issues list grouped by
severity → open an issue → plain-language explanation + fix + affected URLs →
export client report.

### J3 — Agency multi-client workflow

Owner creates organization → invites analysts (roles) → creates one SEO Project
per client → schedules recurring crawls → analysts review, approve
recommendations, generate white-labelled reports → billing meters usage across
clients.

### J4 — Ongoing monitoring

Weekly scheduled crawl + analytics sync → agent diffs against history →
"what changed" digest → anomalies surfaced as notifications → user acts.

### J5 — Authorized publishing (opt-in automation)

User enables automation mode for a channel → agent proposes a
title/description change or a TikTok caption → **approval required by default**
→ user approves → change applied via official API → audit-logged.

---

## 5. MVP boundary

**In (MVP):**

- Auth (email magic-link + Google), organizations, memberships, RBAC, tenant
  isolation, audit logging.
- Billing: Stripe subscriptions, 3 tiers + free, checkout, billing portal,
  webhooks, usage metering + limit enforcement.
- Integrations: YouTube (Data API v3 + Analytics API v2), Google Search Console.
  TikTok connection stub (read-only where the app's API tier allows).
- SEO engine: bounded crawler (robots-aware, SSRF-safe, static HTML + optional
  JS render), core technical checks, issue ranking, per-project history.
- AI: provider abstraction, one conversational agent + the analyst/auditor/
  recommendation/reporting agents behind an orchestrator, structured outputs,
  usage + cost tracking.
- Recommendations, Tasks, Reports (PDF/CSV export), Notifications (in-app +
  email), Dashboard.
- Admin: read-mostly console (users, orgs, subscriptions, usage, jobs, errors,
  audit logs, health).
- Observability: structured logs, error tracking, health checks, basic metrics.

**Out (post-MVP):**

- TikTok deep analytics + authorized publishing workflows (depends on approved
  API access tier).
- Competitor research beyond public, ToS-compliant data.
- ~~Scheduled/recurring crawls + automated monitoring~~ — **shipped** as the
  automation engine (operator's "Phase 12", `docs/AUTOMATION.md`). Digest
  emails still pending a notification channel.
- White-label / custom domains for reports.
- Content calendar, editorial workflow.
- Zapier/Make/public API for customers.
- SSO (SAML/OIDC), SCIM provisioning.
- Multi-region data residency.

**Enterprise (later):**

- SSO + SCIM, custom roles, audit-log export/streaming, DPA + security review
  support, uptime SLA, dedicated rate limits, sandbox org, priority support,
  usage-based invoicing, on-request data deletion workflows.

---

## 6. Monetization model

**Model:** seat-inclusive subscription tiers with **metered usage** for the
expensive resources (AI tokens, crawled pages, connected properties). Payment
provider: **Stripe** (subscriptions, Checkout, Billing Portal, webhooks,
invoices). The app **never stores card data** — Stripe holds all PCI scope.

### Metered resources

Implemented meters (`UsageMeter`, `packages/services/src/usage/meters.ts`):

| Meter                 | Unit                             | Why metered                   |
| --------------------- | -------------------------------- | ----------------------------- |
| `AI_REQUESTS`         | model calls made by the agents   | Orchestration + model cost    |
| `AI_TOKENS`           | prompt + completion tokens       | Direct model cost             |
| `CRAWLS`              | crawls started                   | Compute + bandwidth           |
| `CRAWL_PAGES`         | pages fetched                    | Compute + bandwidth + storage |
| `CONNECTED_ACCOUNTS`  | active OAuth connections (gauge) | External API quota pressure   |
| `REPORTS`             | generated export files           | Rendering + storage           |
| `CONTENT_GENERATIONS` | content-repurposing deliverables | Model cost                    |
| `SEATS`               | active memberships (gauge)       | Standard SaaS                 |

### Subscription tiers (indicative; final numbers set with finance)

| Tier           | Price    | Seats  | AI tokens / mo | Crawl pages / mo | Connected accts | Key limits & features                                               |
| -------------- | -------- | ------ | -------------- | ---------------- | --------------- | ------------------------------------------------------------------- |
| **Free**       | $0       | 1      | 50k            | 500              | 1               | 7-day history, no exports, community support                        |
| **Creator**    | ~$29/mo  | 2      | 500k           | 5,000            | 3               | 90-day history, PDF/CSV export, email support                       |
| **Pro**        | ~$99/mo  | 5      | 3M             | 40,000           | 10              | 12-month history, scheduled crawls, automation mode, priority email |
| **Agency**     | ~$299/mo | 15     | 12M            | 200,000          | 40              | White-label reports, API access, roles, usage dashboard             |
| **Enterprise** | custom   | custom | unlimited      | unlimited        | unlimited       | SSO/SCIM, SLA, audit export, invoicing, DPA                         |

> **Implemented (operator's "Phase 10").** The authoritative definition of every
> tier — display price, per-meter limits, feature flags — is the config catalog
> `packages/services/src/billing/plans.ts` (ADR-0025); this table is a summary.
> The roadmap's "Starter" shipped as **Creator**. Numbers are still indicative.

Overage: soft cap → in-app warning at 80/100%; hard cap → new expensive
operations blocked with a clear upgrade path; **existing data always
readable**. Optional metered overage billing for Pro+ (Stripe usage records).

### Usage-limit enforcement

Every metered operation calls `usage.enforceUsage({ org, meter, amount })`
**server-side, before** doing the work (throws `usage_limit_exceeded` / 429 when
over); on success it records via `usage.recordUsage(...)`, which is idempotent on
an `idempotencyKey`. Limits derive from the active `Subscription.tier` (via the
plan catalog → PLAN `Entitlement` rows) plus any per-org OVERRIDE / PROMO rows.
Enforcement is centralized in the `usage` module — the browser is never trusted
for a limit or billing-authorization decision.

---

## 7. Major risks

| #   | Risk                                                                              | Impact                                   | Mitigation                                                                                                                      |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **TikTok API access tier** may not grant the analytics/publishing scopes we want  | Feature gap vs. spec                     | Ship read-only what's permitted; document the limitation (`TIKTOK-INTEGRATION.md`); gate deep features behind approval          |
| R2  | **YouTube/Google API quota** exhaustion under load                                | Sync failures                            | Per-org quota budgeting, backoff, cache snapshots, nightly batch windows                                                        |
| R3  | **Crawler abused as SSRF proxy**                                                  | Security incident                        | Allowlist + ownership verification, IP-range blocking, scheme/redirect limits, isolated egress (`SEO-ENGINE.md`, `SECURITY.md`) |
| R4  | **AI cost runs ahead of revenue**                                                 | Margin erosion                           | Hard token metering, cheap model for routing, caching, per-tier caps, cost dashboards                                           |
| R5  | **Hallucinated analytics** despite guardrails                                     | Trust + liability                        | Structured outputs only, claim tagging, evidence required, "no data" is a valid answer, eval suite                              |
| R6  | **Multi-tenant data leak**                                                        | Critical                                 | `organizationId` on every tenant row, central scope helper, RLS-style checks, isolation tests in CI                             |
| R7  | **OAuth token compromise**                                                        | Account takeover of connected properties | Encrypted at rest (AES-256-GCM), least-scope requests, rotation, revoke-on-disconnect                                           |
| R8  | **Scope creep** across 18 modules                                                 | Never ships                              | Strict MVP boundary (§5), phase gates (`ROADMAP.md`)                                                                            |
| R9  | **Compliance** (GDPR/CCPA, Google API Services User Data Policy, YouTube API ToS) | Legal / app suspension                   | Data-retention policy, deletion workflow, limited-use compliance, ToS review before launch                                      |
| R10 | **Core Web Vitals field data** often unavailable                                  | Weaker SEO output                        | Use lab metrics, label clearly, integrate CrUX where present                                                                    |

---

## 8. Assumptions

- A1: We can obtain YouTube Data + Analytics API access and Google OAuth
  verification for the requested scopes.
- A2: TikTok Login Kit + Display API access is obtainable; deeper scopes are
  uncertain (see R1).
- A3: Users connect their **own** properties, or have authorization to manage
  the ones they connect. The product does not scrape third parties.
- A4: Postgres, Redis, and S3-compatible storage are available as managed
  services in the target environment.
- A5: One primary region at launch; no data-residency requirements for MVP
  customers.
- A6: English-only UI at launch.
- A7: Stripe is an acceptable payment processor for the target markets.
- A8: A small number of platform-staff accounts operate Admin; customers never
  see it.
