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
- **No Stripe usage-record push** for metered overage yet — limits are hard caps
  enforced at the app; overage billing is a follow-up.
- **`AI_TOKENS` and `CRAWL_PAGES` are enforced as exhaustion gates**, not
  reservations (a call's token / page count is unknowable up front) — a single
  operation can overshoot by one unit before the counter catches up (ADR-0038).
  Phase 13's new atomic `reserveUsage` (§12 below) doesn't change this — it's
  for meters whose quantity *is* known up front.
- **Tier enforcement middleware / RLS** is Phase 3 (auth & tenancy hardening),
  not this phase. Enforcement today is in the `usage` module at each call site.
- The `STARTER` tier from the roadmap shipped as **`CREATOR`**.
- **Credits have no purchase flow** (§10) — the ledger primitive is real and
  race-safe, but nothing sells a one-time credit pack; Stripe Checkout here
  is subscription-only. Grants are support/admin-initiated only.
- **No coupon engine was built** — Stripe's own `allow_promotion_codes: true`
  (already set on every checkout session, `gateway.ts::createCheckoutSession`)
  already lets a customer apply a Stripe-managed promotion code at checkout;
  building a parallel discount system would duplicate what Stripe already
  does correctly.
- **No in-app refund/chargeback flow** — Stripe's own dashboard/portal covers
  this; nothing in this deployment's product requirements asked for
  admin-initiated refunds from inside the app.
- **Tax is not calculated by this app** — if Stripe Tax is enabled on the
  Stripe side, Checkout already handles it; nothing here would need to
  change to support that.
- **USD only** — every plan price and every `Invoice`/`CreditTransaction`
  amount is implicitly USD; `Invoice.currency` mirrors whatever Stripe sends
  (for a future non-USD price), but nothing in the app converts or displays
  a second currency.

See `docs/BILLING-PRODUCTION-AUDIT.md` for the Phase-23 audit matrix (plans ·
lifecycle · security · usage enforcement) and `docs/PHASE-13-REPORT.md` for
this phase's full change log.

---

## 10. Credit ledger (Phase 13)

`billing/credits.ts` — a per-organization, per-meter balance that **adds
to**, never replaces, the plan's own usage allowance. `CreditTransaction` is
append-only (types `PURCHASE` / `GRANT` / `CONSUMPTION` / `REFUND` /
`ADJUSTMENT` / `EXPIRATION`); the current balance is always the
`balanceAfter` of the most recent row for that (org, meter) pair — there is
no mutable `balance` column anywhere. `grantCredits`/`consumeCredits`/
`adjustCredits` are all transactional; `consumeCredits` refuses an overdraft
(throws `validation_failed`, not `usage_limit_exceeded` — a credit shortfall
is a different condition from a plan-limit rejection) rather than letting the
balance go negative. Not yet wired into `usage.check`/`enforceUsage` as an
automatic "spill over into credits when the plan limit is hit" — that
integration is a real, disclosed next step, not implemented this phase
(nothing in the product surface today grants or sells credits, so there was
no live scenario to design that integration against yet).

## 11. Enterprise contracts (Phase 13)

`billing/enterprise.ts` — `EnterpriseContract` is a per-org negotiated
agreement layered as a further override on the existing PLAN → contract →
OVERRIDE/PROMO `Entitlement` resolution (`entitlements.ts::resolveEntitlements`),
never a parallel authorization path. `customEntitlements` mirrors
`Entitlement`'s own `limit:<METER>` / `feature:<name>` key shape. Priority,
per the master brief: a per-key `Entitlement` OVERRIDE/PROMO row still wins
over a contract — "Enterprise does not mean unrestricted." An expired
(`contractEnd` passed) or `CANCELLED` contract simply stops applying; the
org falls back to its plan default, nothing is deleted. No enterprise admin
UI was built this phase (`createEnterpriseContract`/`expireEnterpriseContract`
are real, tested service functions, callable today only from a script or a
future admin action) — a disclosed scope limit, not a missing feature.

## 12. Atomic usage reservation (Phase 13)

`usage/reserve.ts` — closes a real TOCTOU race the existing `enforceUsage`
→ do work → `recordUsage` cycle has: `enforceUsage` only reads the counter,
so N concurrent callers can all see "under the limit" before any of them
writes, overshooting the cap by up to N-1 units. `reserveUsage` combines the
check and the increment into one atomic conditional `updateMany` (`used <=
limit - quantity`) — the same idempotent-claim shape already proven for
mission-task/research-project claiming (Phase 12) — rather than a `SELECT
... FOR UPDATE` this sandbox has no live Postgres to verify raw SQL against.
`releaseUsageReservation` is the "settle down" half: when real usage is less
than what was reserved, the caller releases the unused delta as a negative,
append-only adjustment record, never a rewrite. Migrated onto this phase:
`content-actions.ts`'s `generateAssetsAction` (a variable amount, settled
down to the actual asset count) and `regenerateAssetAction` (fixed amount
1). Every other `enforceUsage`/`recordUsage` call site is unchanged, keeping
its existing, smaller, previously-accepted race window — this was a
deliberate, scoped migration of the two clearest candidates, not a
wholesale rewrite of every metered call site. **A real, hard-won bug fix
along the way**: building this exposed and fixed two genuine bugs in the
shared `testing/memory-db.ts` test harness — a naive whole-row transaction
-rollback that could erase a *different*, concurrently-committed
transaction's write, and a `cmp()` helper that mis-ordered a Number against
a BigInt of the identical value (`4 === 4n` is `false` in JS, and the old
code assumed "not equal, not less-than" meant "greater than," so an
exact-boundary usage check silently rejected a claim that should have
succeeded) — both fixed and now covered by `usage/reserve.test.ts`'s own
10-concurrent-reservations-vs-5-capacity test, which failed under the buggy
harness and passes under the fixed one.

## 13. Pre-downgrade impact check (Phase 13, §29)

`billing/downgrade-impact.ts::getDowngradeImpact` — a read-only report of
exactly what a prospective plan change would affect: which meters' current
usage already exceeds the target plan's cap, which features would be lost,
and whether the org is over the target's seat limit. `plan-change.ts`'s
`changePlan` is unchanged — this is what a UI calls *first* to show a
warning and let the customer decide, never an automatic block. Consistent
with the master instruction: nothing is ever deleted because of a
downgrade; only new usage going forward is capped by the new limit.

## 14. Seat summary (Phase 13, §42)

`getBillingSummary` now returns `seatSummary: { active, invited, limit,
available }` — active members (existing `SEATS` gauge), pending invitations
(not accepted, not revoked, not expired), the effective seat cap (already
enterprise-contract- and override-aware via `resolveEntitlements`), and how
many more the org can add before hitting it. Surfaced on `/app/billing`.
Existing members are never removed automatically for being over a new
limit — same "don't delete data" principle as a downgrade.

## 15. Billing worker queue (Phase 13, §93)

A real `billing` BullMQ queue now exists (`apps/worker/src/processors/
billing.ts`), closing what `docs/BILLING.md`'s own §9 disclosed as a gap
through Phase 12: `runBillingReconcileJob`/`rebuildUsageCountersJob`
(real since Phase 10) were never actually scheduled. Three repeatable
ticks: `reconcile` (every 6h — pulls the truth from Stripe for every org
with a subscription id and re-applies it, then rebuilds that org's usage
counters), `usage-alerts` (every 15 min — 80/90/100% usage-threshold
notifications, idempotent per org/meter/threshold/period,
`billing/alerts.ts::runUsageAlertsJob`), and `trial-ending` (every 6h —
warns an org a few days before `trialEndsAt`; Stripe's own webhook still
drives the actual trial → active/past_due transition,
`runTrialEndingSoonJob`). All three reuse the existing `notifications`
module's idempotent-on-`dedupeKey` upsert — no new notification mechanism.
