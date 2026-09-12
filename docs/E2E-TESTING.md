# E2E-TESTING.md

Phase 27 — a full Playwright browser journey (landing → signup → onboarding
→ dashboard → connect YouTube/TikTok/Search Console → add website → crawl →
issues → AI agent → content → recommendation → task → report → billing →
change plan → logout), plus failure-injection and security tests, on top of
the existing e2e suite from Phase 15 (`docs/QA.md`).

Before writing anything new, I stood up the local dev stack the way CI does
and ran the existing suite exactly as configured — not just read it — and
found a real, previously undetected bug. Fixing it came first; the new tests
came second.

Full design reference: `docs/QA.md` (coverage map), `docs/TESTING.md`
(conventions). Decision record: `docs/DECISIONS.md` ADR-0042.

---

## Finding: `/api/health` returned 500 under the e2e/CI boot configuration

**Where:** `apps/web/app/api/health/route.ts`, root-caused in
`packages/services/src/config/env.ts`.

**Reproduced live**, not inferred: booting `next start` with exactly the env
`apps/web/playwright.config.ts`'s `webServer` and
`.github/workflows/ci.yml`'s `e2e` job already used
(`NODE_ENV=production`, `NEXT_PUBLIC_APP_URL=http://localhost:*`, no
`AUTH_URL`/`ENCRYPTION_KEY`/working sign-in path) made `GET /api/health`
return **500**, not 200 — directly contradicting Phase 13's own documented
contract ("`/api/health`, always 200"). This repo has never been pushed
anywhere (no commits, confirmed via `git log`), so CI has never actually run
this to catch it.

**Root cause.** `config/env.ts`'s prod-strict boot validation
(`loadEnv()`) throws at **module-import time** when required fields are
missing/invalid. `packages/services/src/index.ts` re-exports it eagerly
(`export * as config from './config/env.js'`), and nothing in `apps/web`
ever reads that `config` export — so the throw is pure accidental fallout.
The first route whose bundle happens to import `@growth-agent/services`
(`/api/health`, for its DB/Redis checks) poisons that module in Node's
module cache; every subsequent request touching it gets an uncaught 500.

**Fix 1 — use the escape hatch the module already ships.**
`config/env.ts` already has `GROWTH_AGENT_ENV_STRICT` (only the
footgun/required-field rules are gated on it; type-checking of whatever _is_
provided always runs) — nothing was setting it. Added
`GROWTH_AGENT_ENV_STRICT: '0'` to `playwright.config.ts`'s `webServer.env`
(propagates to CI automatically, since CI's `e2e` job launches the same
config) with a comment explaining why: this is a production _build_ under
test, not a production _deployment_.

**Fix 2 — `/api/health` must stay diagnosable regardless of strict mode.**
Fix 1 unblocks e2e, but a genuinely misconfigured production deploy would
still 500 on its own health check today, which is the opposite of the
endpoint's job. `apps/web/app/api/health/route.ts` now loads every import it
needs (`@growth-agent/services`, `@growth-agent/db`, `@/lib/auth`,
`@/lib/observability`) **dynamically, inside a `try`** — the same
"nested/dynamic import to control when a module evaluates" pattern
`instrumentation.ts` already uses for the identical reason (there, to keep
`bullmq`/`ioredis` out of the edge bundle). A config-load failure is now one
more `checks[]` entry (`{ name: 'config', state: 'down', detail: <message> }`)
inside the normal 200 body, never an uncaught 500. Scoped to this one
route — every other route still fails loudly on a genuinely broken prod
config, which is correct; only the endpoint whose entire purpose is staying
diagnosable gets the extra resilience.

**Verified:** booted `next start` under both configurations directly (not
just via Playwright) and confirmed the JSON body in each case — see
ADR-0042 for the exact reproduction. `apps/web/e2e/api.spec.ts`'s and
`smoke.spec.ts`'s existing `/api/health` assertions now pass for the first
time under this boot configuration; a fresh Playwright run (61 runnable
tests, DB-gated ones self-skipping — see below) confirms it, including the
"health endpoint responds with a dependency status body" case.

**Also added** (`playwright.config.ts`'s `webServer.env`): fake-but-well-formed
`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `TIKTOK_CLIENT_KEY`/`_SECRET`, and a real
32-byte `ENCRYPTION_KEY` — without these, `youtubeConfigured()` /
`tiktokConfigured()` / `searchConsoleConfigured()` all report `false` and the
"Connect" journey step has nothing to click. These never reach a real
provider; they only make our own `/api/integrations/*/connect` route build
and redirect to the real authorize URL, which is as far as an automated test
can safely go (see below).

---

## The journey (`e2e/journey.spec.ts`)

One continuous, serial run through every step in the brief. Real UI
interaction wherever a real user could reach it; direct Prisma seeding only
where the product genuinely has no automatable path — each documented at
the point it happens, following the same honesty convention `docs/QA.md`
already uses for its "N/A" entries:

| Step                                      | How                                                                                                                                                                          | Why not fully automated (if not)                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing → Signup                          | real navigation + `AuthForm` renders                                                                                                                                         | Sign-in is magic-link/Google-OAuth only — no password form exists to automate. The account a magic link would eventually produce is seeded directly (matches `authed.spec.ts`'s existing reasoning), same as Phase 15 already documented                                                                                                                                                                                  |
| Onboarding                                | **fully real**: a zero-membership user is redirected to `/onboarding`, submits `OnboardingForm`, and `createOrgAction` creates the `Organization`/`Membership` rows for real | —                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Dashboard                                 | real render                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Connect YouTube / TikTok / Search Console | real click through to the provider's real authorize host (`accounts.google.com` / TikTok's)                                                                                  | Real consent screens are never automated — no live credentials, and doing so would violate those providers' own automation policies. The _connected_ dashboard state is exercised by seeding the `OAuthConnection`/`YouTubeChannel` row a completed flow would have written                                                                                                                                               |
| Add website + Crawl                       | real form submit, then a real crawl of `https://example.com`                                                                                                                 | Ownership verification (DNS TXT / well-known file) cannot be automated in a test — no bypass exists in the product code, confirmed by reading `verify.ts`; the test writes exactly the row `verifyWebsite()` itself would write on success. The crawl target must be a real public URL — the SSRF guard (`seo/ssrf.ts`) has no allowlist/test escape hatch, confirmed — so this is the one step that touches real network |
| View issues                               | seeded deterministically                                                                                                                                                     | So the assertion never depends on what `example.com` happens to contain                                                                                                                                                                                                                                                                                                                                                   |
| Ask AI Agent                              | fully real, including the SSE stream                                                                                                                                         | No AI key needed — `growthAgentDepsFromEnv()` falls back to a deterministic-only mode, confirmed                                                                                                                                                                                                                                                                                                                          |
| Generate content                          | fully real: create project → analyze → generate                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Create recommendation → Create task       | `/app/monetization`'s `OpportunityCard` → "Create task" (`promoteOpportunityToTaskAction`)                                                                                   | This is the only UI-wired "promote to a Task" control today. `createTaskFromRecommendationAction` (`agent-actions.ts`) exists and is unit-tested at the service layer, but **no page currently calls it** — confirmed by a repo-wide grep. Documented as a finding, not fixed: wiring a new button is a feature change outside an E2E-testing phase                                                                       |
| Generate report                           | fully real                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                         |
| View billing                              | fully real — asserts the "not configured" banner                                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Change plan                               | asserts the plan-change buttons are **disabled**                                                                                                                             | Without `STRIPE_*` configured, `changePlanAction`/`startCheckoutAction` always throw `provider_unavailable` (traced through `NullBillingGateway`) — `billing-panels.tsx` correctly disables those buttons rather than let a user click into a doomed request. Asserting they're disabled _is_ the correct-behavior test, not a workaround                                                                                 |
| Logout                                    | fully real: `UserMenu` → "Sign out" → session cookie invalidated                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Failure injection (`e2e/failures.spec.ts`)

One test per brief item, at the layer where it's actually visible in a live
boot (most of these already have solid _unit_-level coverage per
`docs/QA.md` — this file adds the browser-visible half):

| Scenario                | Test                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network failure         | `page.route()` aborts the agent-stream request; chat shows an error, recovers the Send button                                                                                                        |
| API timeout             | same mechanism as network failure — an aborted/failed fetch, not a stuck spinner                                                                                                                     |
| OAuth failure           | a seeded `OAuthConnection` with `status: 'ERROR'` shows the stored error message, not a blank state                                                                                                  |
| Expired token           | a seeded `REVOKED` connection shows the reconnect prompt                                                                                                                                             |
| Invalid website         | a private-IP URL (`http://127.0.0.1/`) is rejected by `addWebsite`'s `assertSafeUrl` check as a form error; no `Website` row is created                                                              |
| Crawler failure         | a seeded `BLOCKED` crawl renders its `blockedReason`                                                                                                                                                 |
| AI failure              | `page.route()` returns a 500 from agent-stream; the chat surfaces an error bubble                                                                                                                    |
| Payment failure         | covered at the service layer (`billing/webhook.test.ts`); the browser-visible half is the same disabled-CTA behavior as "Change plan" above                                                          |
| Webhook failure         | a malformed (non-JSON, bad signature) billing webhook body is a clean `< 500`, extending `smoke.spec.ts`'s existing case                                                                             |
| Empty account           | a freshly onboarded org with nothing connected: every `/app/*` surface loads without a stack trace, extending `authed.spec.ts`'s existing case to more pages                                         |
| Empty website           | a `Website` with zero crawls prompts "Start crawl," not an error                                                                                                                                     |
| No SEO issues           | a `COMPLETED` crawl with zero `CrawlIssue` rows says "Issues (0)"                                                                                                                                    |
| Thousands of SEO issues | 2,000 seeded issues; the page still returns `< 400` and renders within a generous time ceiling — a regression guard against a future "render everything client-side, no cap" change, not a tight SLA |

## Security (`e2e/security.spec.ts`)

| Category                  | Test                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized routes       | `smoke.spec.ts` already covers every _unauthenticated_ redirect; this file adds the authenticated-but-wrong-permission cases: a VIEWER cannot add a website, cannot call `/api/agent/stream` (403)                                                                                                                                                                                           |
| Cross-user access         | same organization, wrong role — a MEMBER (below `integration:manage`, which is ADMIN+) cannot reach a real OAuth redirect from the connect route                                                                                                                                                                                                                                             |
| Cross-organization access | org A's session requesting org B's `websiteId` / crawl / `projectId` / `automationId` by id — all four confirmed `findFirst({ where: { id, organizationId } })` + `notFound()` sites (`seo/read.ts`, `content/read.ts`, `automation/rules.ts`, plus the crawl-under-website check in the crawl detail page) — asserts a 404 and that the other org's data never appears in the response body |
| Admin restrictions        | extends `authed.spec.ts`'s existing staff-vs-normal-user case to `/admin/organizations`, `/admin/users`, `/admin/system-health`                                                                                                                                                                                                                                                              |

## Shared support (`e2e/support/seed.ts`)

Factors `authed.spec.ts`'s `signIn()` (mint the exact NextAuth JWE session
cookie, no real login) into one module the three new spec files share, plus
seed helpers for the rows the journey/failure/security tests need beyond
user+org: a verified `Website` (writing exactly what `verifyWebsite()`
itself would on success — there is no bypass in the product), a `Crawl` in
any status, a batch of deterministic `CrawlIssue` rows, a "connected"
`OAuthConnection`+`YouTubeChannel` pair (dummy, never-decrypted cipher
material — nothing in these tests calls a real provider), and a
`MonetizationOpportunity`. `authed.spec.ts` itself is untouched — it
predates this file and keeps its own copy of the same pattern.

---

## Verification run and its limits in this environment

`pnpm format:check && pnpm lint && pnpm typecheck` — clean, 14/14.
`pnpm --filter @growth-agent/services test` — 671 tests, unaffected, all
green. `pnpm --filter @growth-agent/web build` — clean.

**A full authenticated Playwright run needs Postgres.** This machine's
Docker Desktop cannot start: `wsl --status` shows no installed WSL
distribution, and `wsl --install` itself fails with
`HCS_E_HYPERV_NOT_INSTALLED` — **virtualization is disabled in the
machine's firmware (BIOS/UEFI)**, which only a physical restart into
firmware setup can fix; nothing available to this session can do that. The
user chose to attempt `wsl --install` rather than skip straight to
DB-less-only verification; the firmware blocker surfaced only after that
attempt.

What was actually verified without Postgres: a full `pnpm --filter
@growth-agent/web test:e2e` run — **61 of 88 tests passed** (every
non-DB-dependent test: `smoke.spec.ts`, `ui.spec.ts`, `api.spec.ts` in full,
including the `/api/health` case this phase's fix targets), and **the
remaining 27 — `authed.spec.ts` plus every new `journey`/`failures`/
`security` test — self-skipped cleanly** (via the same `E2E_AUTHED` +
DB-reachability gate `authed.spec.ts` already established), rather than
erroring. That confirms every new spec file is structurally sound
(compiles, imports resolve, Playwright collects and runs to the skip point)
but does **not** confirm the seeded scenarios and UI assertions inside them
are correct against a real database — that requires either enabling
virtualization on this machine and re-running with Postgres up
(`docker compose up -d postgres redis`, `pnpm db:generate && pnpm --filter
@growth-agent/db migrate:deploy`, then `E2E_AUTHED=1 pnpm --filter
@growth-agent/web test:e2e`), or running in CI, where Postgres is already
provisioned exactly as `.github/workflows/ci.yml`'s `e2e` job describes.

This is a real, disclosed gap, not a silently-skipped one: the journey and
failure/security specs are new and unverified end-to-end pending that
environment fix. `docs/QA.md`'s coverage table is updated to reflect exactly
this state.
