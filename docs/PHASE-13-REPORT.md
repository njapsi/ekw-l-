# PHASE-13-REPORT.md

**Growth Agent — Phase 13: Billing, Usage, Entitlements & Enterprise Plans.**
Final report, following the brief's own §115 template. Per §116: this
report does not claim "payments are production-ready" — it states exactly
what was implemented and exactly what was verified, at what level, leaving
everything else disclosed as untested or not built.

## 1. Executive summary

Phase 13's 117-section brief asked for a from-scratch commercial-platform
audit and hardening pass. The mandatory audit (§1) found the existing
billing system — built across Phases 10, 23 and 31 — already implements
most of what the brief describes, under its own names: a config-driven
plan catalog, a hand-rolled Stripe REST gateway (no SDK), a `Subscription`
mirror, layered `Entitlement` rows (PLAN → OVERRIDE/PROMO), an append-only
`UsageRecord` ledger rolled into `UsageCounter`, and a doubly-idempotent
webhook handler. This phase closed the genuine gaps found: a real
concurrency race in usage enforcement, an unscheduled reconciliation job,
missing usage/trial alerts, and three entirely-absent entities (credit
ledger, enterprise contracts, pre-downgrade impact). It also found and
fixed two real, previously-latent bugs in the shared test harness while
building the concurrency fix — not billing bugs, but bugs that could have
silently hidden concurrency issues in *any* future phase's tests. See
§24-§26 for what remains undone and why.

## 2. Existing billing architecture (as audited, before this phase)

`packages/services/src/billing/*`: `plans.ts` (5-tier config catalog:
FREE/CREATOR/PRO/AGENCY/ENTERPRISE — display price, per-meter limits,
feature flags), `gateway.ts` (`StripeHttpGateway` — `fetch` + form-encoded
bodies, no SDK; `NullBillingGateway` when unconfigured), `config.ts`
(env-driven price-id mapping), `customers.ts`, `checkout.ts` (Checkout +
portal session creation), `subscription.ts` (`applyStripeSubscription` —
the Stripe → mirror sync, `getBillingSummary`), `plan-change.ts` (upgrade/
downgrade/cancel/resume), `entitlements.ts` (`resolveEntitlements` — PLAN
defaults overlaid with live OVERRIDE/PROMO rows), `invoices.ts`,
`webhook.ts` (signature-verified, `BillingEvent`-ledger-idempotent, upsert
-keyed handlers for checkout/subscription/invoice events), `reconcile.ts`
(pull-from-Stripe self-heal), `service.ts` (env wiring), `jobs.ts` (job
-shaped wrappers, unscheduled before this phase), `stripe-signature.ts`.
`packages/services/src/usage/*`: `meters.ts` (10 meters, counter vs. gauge
kind, billing-period resolution), `check.ts`/`enforce.ts`/`record.ts`
(check → do work → record, idempotent on `idempotencyKey`), `summary.ts`
(dashboard read model + self-healing rollup), `ai-budget.ts`/`ai-limit.ts`
(AI-specific gates). Database: `Subscription`, `Entitlement`, `UsageRecord`,
`UsageCounter`, `Invoice`, `BillingEvent` — all present, all tenant-scoped,
all already covered by the CI tenant-scope lint.

## 3. Billing changes (this phase)

- `usage/reserve.ts` (new): atomic `reserveUsage`/`releaseUsageReservation`.
- `billing/alerts.ts` (new): `checkUsageAlertsForOrg`/`runUsageAlertsJob`/
  `runTrialEndingSoonJob`.
- `billing/credits.ts` (new): `grantCredits`/`consumeCredits`/
  `adjustCredits`/`getCreditBalance`/`listCreditTransactions`.
- `billing/enterprise.ts` (new): `createEnterpriseContract`/
  `expireEnterpriseContract`/`getActiveEnterpriseContract`.
- `billing/downgrade-impact.ts` (new): `getDowngradeImpact`.
- `billing/entitlements.ts` (modified): `resolveEntitlements` now layers an
  active enterprise contract between the plan default and OVERRIDE/PROMO
  rows; defensive `.catch(() => null)` so callers/tests without an
  `enterpriseContract` model on their `db` still work unchanged.
- `billing/subscription.ts` (modified): `getBillingSummary` gained
  `seatSummary` (active/invited/limit/available).
- `apps/web/src/server/content-actions.ts` (modified): `generateAssetsAction`/
  `regenerateAssetAction` migrated to `reserveUsage`/`releaseUsageReservation`.
- `apps/worker/src/processors/billing.ts` (new) + `apps/worker/src/queues.ts`
  (modified, new `billingQueue`) + `apps/worker/src/main.ts` (modified,
  3 new repeatable ticks) + `packages/services/src/observability/
queue-names.ts` (modified, new `billing` queue name).
- `apps/web/src/components/app/billing/billing-panels.tsx` (modified):
  seat summary line on `/app/billing`.

## 4. Plan architecture

Unchanged — the existing 5-tier `PLAN_CATALOG` (`billing/plans.ts`) was
audited and found correct: config-driven, no hard-coded prices at call
sites, `selfServe` flag correctly gates ENTERPRISE to sales-assisted only.
Not modified this phase.

## 5. Entitlement architecture

Extended, not replaced. Resolution order is now: system/security
restrictions (RBAC, outside this module) → per-key `Entitlement`
OVERRIDE/PROMO row → active `EnterpriseContract.customEntitlements` → the
subscription plan default. `resolveEntitlements` is the single function
every caller (`checkUsage`, `recordUsage`, `reserveUsage`, `getUsageSummary`,
`getBillingSummary`) already used before this phase and still uses —
no second entitlement-resolution path was created.

## 6. Usage metering

The existing `check`/`enforce`/`record` triad is unchanged. New:
`usage/reserve.ts`'s `reserveUsage` — an atomic, single-database
-round-trip conditional claim (`used <= limit - quantity` via `updateMany`)
that closes the check-then-act race `enforceUsage` alone has under
concurrency, for meters whose quantity is known before work starts.
`releaseUsageReservation` settles a reservation down (or fully back) when
actual usage is less than what was reserved, as a negative append-only
adjustment record — never a rewrite of history.

## 7. AI usage

Unchanged this phase. `usage/ai-budget.ts`'s `enforceAiBudget` (checks
`AI_REQUESTS` + `AI_TOKENS`) and `usage/ai-limit.ts`'s per-user throttle
were audited and found already correct (Phases 22/23/31); `AI_TOKENS`
remains an exhaustion gate (ADR-0038, unchanged — a call's token count
isn't knowable up front, so it can't be reserved the way `reserveUsage`
reserves a known quantity).

## 8. Research usage

Unchanged. `RESEARCH_CALLS` metering (Phase 11/12) was audited and found
already correctly enforced at `research/engine.ts`'s fetch loop.

## 9. Mission usage

Unchanged. Growth Missions' AI-budget enforcement, `maxRetries` wiring,
weekly publish/content-generation throttles, and the `MISSIONS_HALT` kill
switch were all Phase 12 work, re-confirmed still correct, not modified
this phase.

## 10. Credits

New, scoped to the ledger primitive (§10 above / `docs/BILLING.md` §10).
`CreditTransaction` (new Prisma model, additive migration): append-only,
`balanceAfter`-snapshotted, six types (PURCHASE/GRANT/CONSUMPTION/REFUND/
ADJUSTMENT/EXPIRATION — only GRANT/CONSUMPTION/ADJUSTMENT have a real
caller today). `consumeCredits` refuses an overdraft. No purchase/checkout
flow exists — disclosed, not built (§24).

## 11. Overages

Unchanged — hard caps only, no automatic paid-overage billing (was already
disclosed in `docs/BILLING.md` §9 before this phase, still true). The
credit ledger is the closest thing to an overage mechanism today, but it
is not wired into `usage.check`'s automatic flow (§24).

## 12. Subscription lifecycle

Unchanged and re-confirmed correct: `Subscription.status` mirrors Stripe's
own 8-value state machine; `isEntitledStatus` treats ACTIVE/TRIALING/
PAST_DUE as good standing; `plan-change.ts` handles upgrade (prorated),
downgrade (at period end, no proration), cancel (immediate or at period
end), and resume. New this phase: `getDowngradeImpact` — a read-only,
pre-confirmation warning surface, not a change to the lifecycle itself.

## 13. Stripe / webhook changes

None. `webhook.ts`'s signature verification, `BillingEvent`-ledger
idempotency, and per-type upsert handlers were audited and found already
correct (Phase 10, hardened Phase 31). Not modified this phase.

## 14. Enterprise billing

New. `EnterpriseContract` (new Prisma model, additive migration):
`contractStart`/`contractEnd`/`seatLimit`/`customEntitlements` (JSON,
reusing `Entitlement`'s own `limit:<METER>`/`feature:<name>` key shape)/
`billingTerms`/`supportLevel`. Layered into `resolveEntitlements` between
the plan default and a per-key override (which still wins — "Enterprise
does not mean unrestricted," §88). No admin UI — the service functions are
real, tested, and callable today only from a script or a future admin
action (§24).

## 15. Billing UI

`/app/billing` gained one new line (seat summary: active/invited/limit
/available) in `billing-panels.tsx`. No other UI changes this phase — the
existing plan comparison, usage bars, invoice list, and upgrade/downgrade/
cancel controls were audited and found already solid (Part 82/83's own
asks). No usage-dashboard filtering-by-user/team/feature UI was built
(§24) — the underlying `UsageRecord.actorId`/`subjectType`/`subjectId`
fields already carry that data; only the UI to slice by it doesn't exist.

## 16. Database changes

One new, additive migration, `20260930120000_billing_v2`:
- New enums: `CreditTransactionType` (6 values), `EnterpriseContractStatus`
  (3 values).
- New tables: `credit_transactions`, `enterprise_contracts`.
- New indexes: `credit_transactions(organizationId, meter, createdAt)`,
  a unique index on `enterprise_contracts(organizationId)`.
- New foreign keys: both new tables reference `organizations(id)` with
  `ON DELETE CASCADE`.
- Zero `DROP`, zero column rewrite on any existing table.
- `prisma validate` and `prisma generate` both ran clean against dummy
  `DATABASE_URL`/`DIRECT_URL` values (no live Postgres in this sandbox —
  the same disclosed limitation every phase since 24 has had for a
  hand-authored migration reviewed by eye rather than run through
  `prisma migrate dev`).

## 17. Worker changes

New `billing` BullMQ queue (`apps/worker/src/processors/billing.ts`),
registered in `main.ts` with three repeatable ticks: `reconcile` (every
6h), `usage-alerts` (every 15 min), `trial-ending` (every 6h). All three
call existing or newly-added plain `packages/services` functions — the
worker file itself is pure dispatch-on-`job.data.type` wiring, matching
the `automation`/`integrations`/`missions` queue precedent exactly.

## 18. Security changes

None directly billing-security-specific this phase (Phase 12 already
covered fail-closed rate limiting, MFA, etc.). Indirectly: the new
`creditTransaction`/`enterpriseContract` models were added to
`scripts/check-tenant-scope.mjs`'s allowlist *at the same time* they were
introduced (learning from Phase 12's own finding that 21 models had gone
unchecked for multiple phases) — confirmed clean by the lint, meaning
every query against them really is `organizationId`-scoped, not merely
unchecked.

## 19. Tests

New test files: `packages/services/src/usage/reserve.test.ts` (10 tests,
including the brief's own named 10-concurrent-vs-5-capacity acceptance
scenario), `packages/services/src/billing/credits.test.ts` (7 tests),
`packages/services/src/billing/enterprise.test.ts` (6 tests),
`packages/services/src/billing/downgrade-impact.test.ts` (4 tests) — 27
new test cases total, exactly matching this phase's net test-count
increase. One existing test file fixed for a real regression its own
hand-rolled fixture caused once `resolveEntitlements`/`getBillingSummary`
gained new dependencies (`enterpriseContract`, `invitation.count`) —
`billing/subscription.test.ts` (added `invitation: { count: ... }` to its
fixture, plus a new assertion on `seatSummary`). Two permanent fixes to
the shared `testing/memory-db.ts` harness (a correct per-row transaction
-rollback journal, and a `cmp()` fix for Number/BigInt boundary equality)
that benefit every future phase's concurrency-sensitive tests, not just
this one.

## 20. Tests passed

- `packages/services`: **183 test files, 1403 tests, all passing**
  (up from 1376 at the start of this phase — 1356 + Phase 12's own +20,
  then +27 net this phase after the new tests and two fixture fixes).
- `node scripts/check-tenant-scope.mjs`: clean (new models covered).
- `node scripts/audit-allow.mjs`: clean, no new advisories.
- `pnpm lint` (all 14 packages/apps): clean, 0 errors — including 8 real
  ESLint errors this phase's own `memory-db.ts` changes introduced
  (unnecessary type assertions, unbound-method warnings on the new
  transaction-wrapper), found and fixed before this report was written.
- `prisma validate` / `prisma generate`: clean against the new schema.
- `pnpm --filter @growth-agent/web typecheck` / `pnpm --filter
@growth-agent/services typecheck` / `pnpm --filter @growth-agent/worker
typecheck`: all clean.
- `pnpm --filter @growth-agent/web build`: production build, confirmed
  clean (see the gate log this report's companion summary message cites).

## 21. Tests failed

None outstanding. Two regressions were introduced and fixed *during* this
phase (both described in §19/§20 above) before the final gate run — they
are not open failures.

## 22. Environment variables

No new environment variables were introduced this phase. Credits,
enterprise contracts, and the new worker queue all use the existing
`DATABASE_URL`/`REDIS_URL`/`STRIPE_*` configuration — no new secret, no
new required config.

## 23. Migrations

One: `packages/db/prisma/migrations/20260930120000_billing_v2/migration.sql`
(additive, see §16). Following this project's own established migration
checklist (`docs/DATABASE.md`): reviewed by eye against Prisma's own
`CreateEnum`/`CreateTable`/`CreateIndex`/`AddForeignKey` generated-SQL
pattern from the five most recent prior migrations; no live Postgres in
this sandbox to run `prisma migrate dev`/`migrate deploy` against, the
same disclosed limitation as every hand-authored migration since Phase 24.
`prisma validate` confirms the schema itself is internally consistent;
`prisma generate` confirms the generated client compiles and every
consuming package typechecks against it.

## 24. Known limitations (disclosed, not hidden)

- No credit-purchase/checkout flow — the ledger primitive works, nothing
  sells credits yet.
- No automatic "spill into credits when the plan limit is hit" integration
  in `usage.check` — deliberately not built without a real product
  scenario to validate it against (ADR-0062).
- No enterprise-contract admin UI — service functions only.
- `reserveUsage` was migrated onto exactly two call sites
  (`generateAssetsAction`/`regenerateAssetAction`); every other
  `enforceUsage`/`recordUsage` pair keeps its pre-existing, smaller,
  previously-accepted race window.
- No coupon engine (Stripe's `allow_promotion_codes` already covers it),
  no in-app refund/chargeback flow, no tax calculation, no multi-currency
  support — all deliberately out of scope per the brief's own "don't
  unnecessarily build" guidance (§64).
- No MRR/ARR/churn/plan-distribution admin reporting was built — the
  existing `/admin/subscriptions` page (tier/status breakdown, trials
  -ending count) was audited and judged to already cover the brief's core
  "billing admin visibility" ask (§37/§80); building financial analytics
  reporting on top was judged out of this phase's scope without a
  specific requirement driving it.
- No usage-dashboard UI for filtering by user/team/feature/platform
  (§40) — the underlying data (`UsageRecord.actorId`/`subjectType`/
  `subjectId`) already supports it; only the UI doesn't exist yet.
- No live Stripe integration test was run (no live Stripe test-mode
  credentials in this sandbox) — webhook/checkout/portal code paths are
  unit-tested against a fake gateway, not exercised against the real
  Stripe API.
- No live database migration was applied (§16/§23) — schema and generated
  client validated, not run against a real Postgres instance.

## 25. Remaining risks

| Risk | Severity | Notes |
|---|---|---|
| `reserveUsage`'s conditional-`updateMany` atomicity is unverified against real Postgres | MEDIUM | Correct by Postgres's documented `UPDATE ... WHERE` semantics and proven against the (now-fixed) in-memory harness; no live database in this sandbox to confirm under real concurrent transactions. |
| The credit ledger has no consumer wired to it yet | LOW | A real, tested, unused capability — no risk until something calls it, but also no proof it integrates cleanly with a real feature until one does. |
| Enterprise contracts have no admin UI, so today only a script/future action can create one | LOW | Intentional scope limit, not a bug — but it means the feature is not yet usable end-to-end by a human operator. |
| The new migration has not been applied to any real database | MEDIUM | Same disclosed limitation as every hand-authored migration since Phase 24 — schema-valid, not execution-proven. |
| Two existing test fixtures needed a fix this phase (`resolveEntitlements`/`getBillingSummary`'s new dependencies) | LOW | Both found and fixed before this report; the pattern (a hand-rolled fixture predating a new required dependency) could recur for a *future* phase's next addition to these functions — worth watching. |

## 26. Production requirements (before any GA claim)

1. Apply `20260930120000_billing_v2` to a real Postgres instance and
   confirm `prisma migrate deploy` succeeds (this sandbox cannot do this).
2. Run the full billing + usage test suite against real Stripe **test
   mode** credentials at least once (checkout → webhook → entitlement
   update → cancel), matching this project's own "Stripe TEST mode only"
   convention for a real dry run.
3. Decide whether `reserveUsage` should be migrated onto more call sites
   (it is currently proven on two) before treating concurrency-safety as
   a blanket guarantee across every metered feature.
4. Decide whether the credit ledger needs a purchase flow, or whether it
   stays support-grant-only, before advertising "credits" as a customer
   -facing feature.
5. Build the enterprise-contract admin UI before selling an actual
   enterprise deal that depends on it.
