# BILLING.md

Status: **implemented (operator's "Phase 10")**. Code:
`packages/services/src/billing` + `packages/services/src/usage`,
`apps/web/src/server/billing-actions.ts`, `apps/web/app/api/billing/webhook`,
`apps/web/app/(app)/app/billing`. Design decisions: ADR-0010 (Stripe +
metered usage) and ADR-0025 (this implementation).

Production SaaS billing: configuration-based plans, Stripe Checkout /
subscriptions / portal / invoices, upgrades / downgrades / cancellation,
signature-verified **idempotent** webhooks, feature entitlements, and
**server-side** usage-limit enforcement. Stripe holds all card data — the app
stores only ids and non-sensitive mirrors.

---

## 1. The plan catalog (config, not a table)

`billing/plans.ts` `PLAN_CATALOG` is the single source of truth for the five
tiers. Master instruction: _"Do not hard-code prices throughout the application.
Create configuration-based plans."_

| Tier           | Self-serve | Notes                                         |
| -------------- | ---------- | --------------------------------------------- |
| **FREE**       | no         | the default; no Stripe objects                |
| **CREATOR**    | yes        | (the roadmap's "Starter", renamed — ADR-0025) |
| **PRO**        | yes        |                                               |
| **AGENCY**     | yes        |                                               |
| **ENTERPRISE** | no         | sales-assisted; unlimited everything          |

Each `PlanDefinition` carries: `priceUsd` (**display only**, whole USD — the real
charge is the linked Stripe Price), `order`, `selfServe`, `limits`
(`Record<UsageMeter, number | null>`, `null` ⇒ unlimited), and `features`
(`exports`, `scheduledCrawls`, `whiteLabelReports`, `automationMode`,
`apiAccess`, `prioritySupport`, `sso`).

Stripe **Price IDs** are environment config (`billing/config.ts` →
`STRIPE_PRICE_<TIER>_<MONTH|YEAR>`), never in the catalog, so the same catalog
runs in every environment. `tierForPrice()` is the reverse lookup used when a
webhook arrives.

The marketing pricing page and the in-app plan grid both render from
`billing.listPlans()`.

---

## 2. The Stripe gateway (no SDK)

`billing/gateway.ts` defines `BillingGateway` and two implementations:

- **`StripeHttpGateway`** — calls the Stripe REST API with `fetch` and
  form-encoded bodies (`toFormBody` does Stripe's `a[b][c]` bracket notation);
  `Authorization: Bearer <secret>`. `fetch` is injectable for tests. Webhook
  bodies are verified by `stripe-signature.ts` (`node:crypto` HMAC-SHA256 over
  `"<t>.<rawBody>"`, ±300s tolerance) before `JSON.parse`.
- **`NullBillingGateway`** — returned by `createBillingGateway` when
  `STRIPE_SECRET_KEY` is unset. Reads return empty; mutations throw
  `provider_unavailable`. The app still runs — everyone is FREE and limits are
  still enforced.

No Stripe SDK, no new dependency (ADR-0025, same reasoning as ADR-0004 for AI).

---

## 3. Subscription mirror

One `Subscription` row per org (`getOrCreateSubscription` lazily creates a FREE
one). Stripe is the source of truth for money; `applyStripeSubscription` maps a
Stripe subscription object onto our row — resolving tier + interval from the
price id (an **unknown price keeps the current tier**, never guesses), mapping
status, and re-running `syncPlanEntitlements` when the tier moves. A
`customer.subscription.deleted` event calls `downgradeToFree`.

`SubscriptionStatus`: `TRIALING · ACTIVE · PAST_DUE · CANCELED · INCOMPLETE ·
INCOMPLETE_EXPIRED · UNPAID · PAUSED`. `ACTIVE` / `TRIALING` / `PAST_DUE` keep
product access (`isEntitledStatus`).

---

## 4. Flows (Server Actions, `billing:manage` — OWNER only)

| Action                     | Function                     | Behaviour                                                                     |
| -------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `startCheckoutAction`      | `billing.startCheckout`      | ensures a Stripe customer, returns a Checkout URL; rejects non-self-serve     |
| `openBillingPortalAction`  | `billing.openBillingPortal`  | returns a Billing Portal URL (needs an existing customer)                     |
| `changePlanAction`         | `billing.changePlan`         | upgrade = prorated; downgrade = `proration_behavior: none`; no sub → checkout |
| `cancelSubscriptionAction` | `billing.cancelSubscription` | `cancel_at_period_end` — access kept until the period ends                    |
| `resumeSubscriptionAction` | `billing.resumeSubscription` | clears a pending cancellation                                                 |

The browser only ever receives a Stripe-hosted URL to redirect to — it never
carries a billing-authorization decision.

`billing.getBillingSummary(orgId)` powers `/app/billing`: current plan + status,
renewal / cancellation notice, the usage dashboard, the plan grid, and the
invoice list.

---

## 5. Webhooks — idempotent two ways

`POST /api/billing/webhook` (public; Stripe is the caller). `billing/webhook.ts`:

1. **Ledger** — `BillingEvent` row id **is** the Stripe event id. A redelivery
   finds a `PROCESSED` / `SKIPPED` row and returns `deduped` before any work; a
   concurrent insert race also resolves to `deduped`.
2. **Convergent handlers** — every handler is an upsert keyed on a Stripe id
   (`stripeSubscriptionId`, `stripeInvoiceId`), so even a torn processing run
   converges to the same state.

Handled: `checkout.session.completed`, `customer.subscription.created / updated /
deleted / paused / resumed`, `invoice.created / finalized / paid /
payment_succeeded / payment_failed / voided / marked_uncollectible`. Unknown
types are recorded `SKIPPED` (not an error). Bad signature → `400` (no retry);
handler exception → `500` and the row stays `FAILED` for retry on redelivery.

`billing.reconcileOrganization` / `reconcileAllOrganizations` pull the truth from
Stripe for a nightly self-heal, and also `refreshUsageCounters`.

**Lifecycle visibility (Phase 23).** `invoice.payment_failed` and a move into
`PAST_DUE` / `UNPAID` write an org-wide `WARNING` `Notification`
(`billing.payment_failed` / `billing.past_due`, idempotent on `dedupeKey`,
links to `/app/billing`); `invoice.payment_succeeded` / `invoice.paid` write an
`INFO` `billing.payment_recovered` notice. These use the shared
`createNotification` (never throws, best-effort email fan-out) — a
notification-write failure can never break webhook processing.

---

## 6. Entitlements

`Entitlement` rows, keyed `limit:<METER>` or `feature:<name>`,
`@@unique([organizationId, key])`:

- `syncPlanEntitlements(orgId, tier)` rewrites the **PLAN**-source rows from the
  catalog on every plan change. Idempotent.
- `resolveEntitlements(orgId)` returns `{ tier, limits, features, overridden }`:
  catalog defaults for the current tier, overlaid with live **OVERRIDE** /
  **PROMO** rows (support-granted exceptions win; expired ones are ignored).
- `setEntitlementOverride` / `clearEntitlementOverride` — audited support tools.

---

## 7. Usage metering (`usage` module)

Split from `billing` (ADR-0025). Meters (`UsageMeter`): `AI_REQUESTS`,
`AI_TOKENS`, `CRAWLS`, `CRAWL_PAGES`, `CONNECTED_ACCOUNTS`, `REPORTS`,
`CONTENT_GENERATIONS`, `SEATS`. `CONNECTED_ACCOUNTS` and `SEATS` are **gauges**
(a live count); the rest are **counters** that accumulate over the billing
period (the org's Stripe period, or the calendar month as a fallback).

| Step        | Function                     | Notes                                                                                           |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| **check**   | `usage.checkUsage`           | returns `{ unlimited, limit, used, remaining, wouldExceed, ratio, ... }`; no mutation           |
| **enforce** | `usage.enforceUsage`         | throws `usage_limit_exceeded` (429) when `wouldExceed`; **server-side only**                    |
| **record**  | `usage.recordUsage`          | appends `UsageRecord` + increments `UsageCounter` in one tx; **idempotent** on `idempotencyKey` |
| **rollup**  | `usage.refreshUsageCounters` | rebuilds counters from the ledger (self-healing)                                                |
| **read**    | `usage.getUsageSummary`      | per-meter snapshot for the dashboard, with an `ok` / `warn` / `over` state                      |

### Where enforcement + recording is wired

- **SEO crawl** (`startCrawlAction`) — `enforceUsage(CRAWLS)` **and**
  `enforceUsage(CRAWL_PAGES, 1)` before (the latter is a Phase-23 "page budget
  exhausted" gate — the exact count is unknowable up front);
  `recordUsage(CRAWLS)` + `recordUsage(CRAWL_PAGES, pagesCrawled)` after.
- **Content generation** (`generateAssetsAction`) —
  `enforceUsage(CONTENT_GENERATIONS)` before; `recordUsage` for the assets made.
- **AI** — `usage.enforceAiBudget({ organizationId })` (Phase 23) enforces
  **both** `AI_REQUESTS` and `AI_TOKENS` before every model turn:
  `/api/agent/stream` and the YouTube / TikTok / monetization / SEO-agent
  Server Actions. `AI_REQUESTS` is reservable (`amount: 1`); `AI_TOKENS` is an
  exhaustion gate (blocks the _next_ request once the budget is spent).
  `recordAgentRunUsage` (AI_REQUESTS + AI_TOKENS from the `AgentRun`) records
  after; `runGrowthAgentTurnJob` / `runMonetizationScanJob` / the analyst jobs
  call it too. A fail-open Redis **per-user** throttle (`enforceAiUserLimit`,
  Phase 22) sits in front.
- **Connected accounts** — the YouTube + TikTok + Search Console OAuth connect
  routes `enforceUsage(CONNECTED_ACCOUNTS)` before starting the flow.
- **Reports** — `reports/generate.ts` `enforceUsage(REPORTS)` before building
  and `recordUsage(REPORTS)` after the snapshot is `READY`.

`createAiUsageSink` is also available as an `@growth-agent/ai` `UsageSink` for
call sites that thread a live sink into the registry.

---

## 8. Environment

All optional. With none set the app is FREE-for-everyone, limits still enforced,
and mutating billing calls return `provider_unavailable`.

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_CREATOR_MONTH=price_...
STRIPE_PRICE_CREATOR_YEAR=price_...
STRIPE_PRICE_PRO_MONTH=price_...
STRIPE_PRICE_PRO_YEAR=price_...
STRIPE_PRICE_AGENCY_MONTH=price_...
STRIPE_PRICE_AGENCY_YEAR=price_...
# optional: STRIPE_API_BASE_URL (default https://api.stripe.com),
#           STRIPE_API_VERSION (default 2024-06-20)
```

Register the webhook endpoint `https://<host>/api/billing/webhook` in the Stripe
dashboard and subscribe it to `checkout.session.*`, `customer.subscription.*`
and `invoice.*`.

---

## 9. Documented limitations (do not fake)

- **No card data, ever.** Stripe holds all PCI scope; the app stores only
  `stripeCustomerId` / `stripeSubscriptionId` / `stripePriceId` and an
  amounts-only `Invoice` mirror.
- **The scan-style reconcile + counter rollup run inline** (ADR-0013 pattern) —
  no worker queue was added; `runBillingReconcileJob` / `rebuildUsageCountersJob`
  are ready for a scheduler. Subscription _expiration_ between webhooks is
  covered by the `resolvePeriod` calendar-month fallback + the nightly
  reconcile.
- **No Stripe usage-record push** for metered overage yet — limits are hard caps
  enforced at the app; overage billing is a follow-up.
- **`AI_TOKENS` and `CRAWL_PAGES` are enforced as exhaustion gates**, not
  reservations (a call's token / page count is unknowable up front) — a single
  operation can overshoot by one unit before the counter catches up (ADR-0038).
- **Tier enforcement middleware / RLS** is Phase 3 (auth & tenancy hardening),
  not this phase. Enforcement today is in the `usage` module at each call site.
- The `STARTER` tier from the roadmap shipped as **`CREATOR`**.

See `docs/BILLING-PRODUCTION-AUDIT.md` for the Phase-23 audit matrix (plans ·
lifecycle · security · usage enforcement).
