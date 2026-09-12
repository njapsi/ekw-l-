# BILLING-PRODUCTION-AUDIT.md

Phase 23 — production audit of the subscription + metering system. Status:
**verified** = already correct, checked against source; **hardened** = changed
this phase. Full design in `docs/BILLING.md`; rationale in `docs/DECISIONS.md`
ADR-0010 / ADR-0025 / ADR-0038.

---

## 1. Plans

`billing/plans.ts` `PLAN_CATALOG` is the single source of truth. **Verified** —
`billing/plans.test.ts` pins all of the below.

| Tier           | Self-serve   | AI reqs | AI tokens | Crawls | Crawl pages | Accounts | Reports | Content gen | Seats | Features                                           |
| -------------- | ------------ | ------- | --------- | ------ | ----------- | -------- | ------- | ----------- | ----- | -------------------------------------------------- |
| **FREE**       | no (default) | 100     | 50 K      | 2      | 500         | 1        | 0       | 10          | 1     | none                                               |
| **CREATOR**    | yes          | 2 000   | 500 K     | 20     | 5 000       | 3        | 20      | 150         | 2     | exports                                            |
| **PRO**        | yes          | 12 000  | 3 M       | 150    | 40 000      | 10       | 200     | 1 000       | 5     | + scheduledCrawls, automationMode, prioritySupport |
| **AGENCY**     | yes          | 60 000  | 12 M      | 800    | 200 000     | 40       | 1 000   | 5 000       | 15    | + whiteLabelReports, apiAccess                     |
| **ENTERPRISE** | no (sales)   | ∞       | ∞         | ∞      | ∞           | ∞        | ∞       | ∞           | ∞     | all (+ sso)                                        |

Every meter has a limit in every tier; limits increase monotonically FREE →
AGENCY; ENTERPRISE is all `null` (unlimited) with every feature `true`; prices
are **display-only** (`priceUsd`), the real charge is the linked Stripe Price
(`billing/config.ts` env). `purchasableTiers()` = `[CREATOR, PRO, AGENCY]`.

## 2. Lifecycle

| Step                    | Where handled                                                                                                                                                                                                  | Test                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Signup                  | `getOrCreateSubscription` lazily writes a FREE mirror + FREE `Entitlement` rows                                                                                                                                | `lifecycle.test.ts` "signup"                                                 |
| Checkout                | `startCheckout` → `ensureStripeCustomer` + `createCheckoutSession`; refuses FREE / ENTERPRISE; returns a **Stripe-hosted URL only**                                                                            | `lifecycle.test.ts` "checkout", `checkout.test.ts`                           |
| Subscription creation   | `checkout.session.completed` webhook → `applyStripeSubscription` → tier + status + period from the Stripe object; PLAN entitlements re-synced                                                                  | `lifecycle.test.ts` step 1, `webhook.test.ts`                                |
| Upgrade                 | `changePlan` (`isUpgrade`) → Stripe `proration_behavior: create_prorations`; mirror refreshed, entitlements re-synced                                                                                          | `lifecycle.test.ts` step 2, `plan-change.test.ts`                            |
| Downgrade               | `changePlan` (`isDowngrade`) → `proration_behavior: none` (applies at period end)                                                                                                                              | `lifecycle.test.ts` step 3                                                   |
| Cancellation            | `cancelSubscription` → `cancel_at_period_end: true`; `isEntitledStatus` stays true until the period ends                                                                                                       | `lifecycle.test.ts` step 4, `plan-change.test.ts`                            |
| Resume                  | `resumeSubscription` → clears `cancel_at_period_end`                                                                                                                                                           | `lifecycle.test.ts` step 5                                                   |
| Renewal                 | `customer.subscription.updated` webhook with a new period → mirror period advances, status ACTIVE                                                                                                              | `lifecycle.test.ts` step 6                                                   |
| Failed payment          | `customer.subscription.updated` → status `PAST_DUE` (still entitled); `invoice.payment_failed` → invoice mirror + audit + **`billing.payment_failed` WARNING notification** (Phase 23)                         | `lifecycle.test.ts` step 7, `webhook.test.ts` "invoice.payment_failed …"     |
| Payment recovery        | status back to ACTIVE via `customer.subscription.updated`; `invoice.payment_succeeded` / `invoice.paid` → **`billing.payment_recovered` INFO notification** (Phase 23)                                         | `lifecycle.test.ts` step 8                                                   |
| Billing portal          | `openBillingPortal` → `createPortalSession` (needs an existing `stripeCustomerId`); Stripe-hosted URL only                                                                                                     | `checkout.test.ts` "openBillingPortal"                                       |
| Invoice                 | `invoice.*` webhooks → `upsertInvoiceFromStripe` (amounts + urls only, **no line items, no card data**), keyed on `stripeInvoiceId`                                                                            | `webhook.test.ts` "invoice.paid …"                                           |
| Webhook                 | see §3                                                                                                                                                                                                         | `webhook.test.ts`, `webhook.integration.test.ts`, `stripe-signature.test.ts` |
| Subscription expiration | between webhooks, `resolvePeriod` falls back to the calendar month so counters reset; the nightly `reconcileOrganization` re-pulls Stripe and re-applies (`customer.subscription.deleted` → `downgradeToFree`) | `expiration.test.ts`                                                         |

## 3. Security

| Requirement                                    | Mechanism                                                                                                                                                                                                                                                                        | Test                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Never trust client-side subscription state** | the browser only ever receives a Stripe-hosted URL to redirect to; `/app/billing/page.tsx` passes `canManage` to the client **for display only**; every entitlement decision reads the server-side `Entitlement` overlay                                                         | `checkout.test.ts`, `entitlements.test.ts`                                                                         |
| **Authorization is server-side**               | every Server Action in `apps/web/src/server/billing-actions.ts` re-checks `requirePermission('billing:manage')` (OWNER-only) before touching Stripe                                                                                                                              | `rbac/authorize.test.ts` + the action guards                                                                       |
| Webhook **authenticated**                      | `stripe-signature.ts` — HMAC-SHA256 over `"<t>.<rawBody>"`, ±300 s tolerance, `node:crypto`, constant-time compare; verified **before** `JSON.parse`; bad signature → route 400, no retry                                                                                        | `stripe-signature.test.ts`, `webhook.test.ts` "a bad signature throws before any ledger write"                     |
| Webhook **idempotent**                         | (1) `BillingEvent` ledger: row id **is** the Stripe event id — a redelivery finds `PROCESSED`/`SKIPPED` and returns `deduped` before any work; a concurrent insert race (`P2002`) also → `deduped`. (2) every handler is an upsert keyed on a Stripe id, so a torn run converges | `webhook.test.ts` "is idempotent …", `lifecycle.test.ts` "a redelivered event id …", `webhook.integration.test.ts` |
| Webhook **logged**                             | pino logger `billing.webhook` on every failed handler + every retried event; the route logs a bad signature and a processing failure                                                                                                                                             | code (`webhook.ts` / `route.ts`)                                                                                   |
| Webhook **retry-safe**                         | a handler exception → the `BillingEvent` row is set `FAILED` and the error is **rethrown** → route returns 500 → Stripe redelivers → the `FAILED` row is picked up and retried (not deduped); unknown event type → `SKIPPED` (not an error)                                      | `webhook.test.ts` "retry-safe — a handler exception …"                                                             |
| No card data                                   | Stripe holds all PCI scope; the app stores only `stripeCustomerId` / `stripeSubscriptionId` / `stripePriceId` + an amounts-only `Invoice` mirror                                                                                                                                 | code + `docs/BILLING.md` §9                                                                                        |

## 4. Usage enforcement

`usage.enforceUsage` (throws `usage_limit_exceeded`, HTTP 429) is the single
server-side gate. **`enforcement.test.ts`** proves an at/over-cap call is refused
for every meter below; an unlimited plan is never refused; a live `OVERRIDE`
raises the ceiling.

| Meter                 | Enforced pre-flight                                                                                                                                        | Where                                                                                                     | Recorded                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `AI_REQUESTS`         | ✅ (reservable, `amount: 1`)                                                                                                                               | `enforceAiBudget` at `/api/agent/stream` + the YouTube / TikTok / monetization / SEO-agent Server Actions | `recordAgentRunUsage` after the run            |
| `AI_TOKENS`           | ✅ **exhaustion gate** (Phase 23) — `enforceAiBudget` blocks the next request once the token budget is spent (a call's token count is unknowable up front) | same call sites                                                                                           | `recordAgentRunUsage` (prompt + completion)    |
| `CRAWLS`              | ✅ (reservable)                                                                                                                                            | `startCrawlAction`                                                                                        | `recordUsage(CRAWLS)` after                    |
| `CRAWL_PAGES`         | ✅ **exhaustion gate** (Phase 23) — `enforceUsage(CRAWL_PAGES, amount: 1)` at `startCrawlAction` blocks a new crawl when the page budget is spent          | `startCrawlAction`                                                                                        | `recordUsage(CRAWL_PAGES, pagesCrawled)` after |
| `CONNECTED_ACCOUNTS`  | ✅ (gauge — live count)                                                                                                                                    | the YouTube / TikTok / Search Console OAuth **connect** routes                                            | n/a (gauge)                                    |
| `REPORTS`             | ✅ (reservable)                                                                                                                                            | `reports/generate.ts` before building; `recordUsage` after `READY`                                        | `reports/generate.ts`                          |
| `CONTENT_GENERATIONS` | ✅ (reservable, `amount: types.length`)                                                                                                                    | `generateAssetsAction`                                                                                    | `recordUsage` for the assets made              |
| `SEATS`               | ✅ (gauge)                                                                                                                                                 | invitation / membership creation                                                                          | n/a (gauge)                                    |

The per-org caps are backed by `checkUsage` reading `resolveEntitlements`
(catalog + live `OVERRIDE`/`PROMO`). A separate fail-open Redis **per-user** AI
throttle (`enforceAiUserLimit`, Phase 22) sits in front of the per-org AI caps.

---

## Residual risk

- **`AI_TOKENS` / `CRAWL_PAGES` are exhaustion gates, not reservations.** A
  single model call or crawl can overshoot the cap by one unit's worth before
  the counter catches up — matches how every post-hoc counter meter behaves
  (ADR-0038). Hard reservation would need an upfront estimate the API does not
  provide.
- No Stripe usage-record push for metered overage — limits stay hard caps at
  the app (documented follow-up, `BILLING.md` §9).
- The reconcile + counter rollup run inline (ADR-0013) — `runBillingReconcileJob`
  / `rebuildUsageCountersJob` are scheduler-ready but no worker queue is wired.
- Live Stripe flows (real checkout, a real card decline, the real portal) are
  exercised only by the manual smoke; the fake gateway + typed Stripe shapes +
  the `stripe-signature` tests are the local guarantee.
