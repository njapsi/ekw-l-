# QA.md

Production-level QA coverage map (operator's "Phase 15"; extended by Phase
27's full journey/failure/security e2e pass — `docs/E2E-TESTING.md`). It
records **what is tested, at which layer, and where it runs** for every area
and failure scenario the QA brief names. Test conventions live in
`docs/TESTING.md`.

## Layers & where they run

| Layer                       | Command                                                      | Local                                                                              | CI                                  |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------- |
| Unit                        | `pnpm test`                                                  | ✅ (671 `packages/services` tests)                                                 | ✅                                  |
| Integration (real Postgres) | `pnpm --filter @growth-agent/{db,services} test:integration` | self-skips (no Docker)                                                             | ✅ (Postgres service)               |
| E2E — public + API contract | `pnpm --filter @growth-agent/web test:e2e`                   | ✅ (`next start`, no DB — 61/61 passing)                                           | ✅                                  |
| E2E — authenticated browser | same, gated by `E2E_AUTHED=1`                                | skips (self-skip confirmed; **unverified end-to-end** — see `docs/E2E-TESTING.md`) | ✅ (seeds + mints a session cookie) |
| Lint / typecheck            | `pnpm lint` · `pnpm typecheck`                               | ✅                                                                                 | ✅                                  |
| Web build                   | `pnpm --filter @growth-agent/web build`                      | ✅                                                                                 | ✅                                  |

> There is no local Docker in this environment — Phase 27 confirmed the exact
> cause: virtualization is disabled in this machine's firmware, so WSL2 (and
> therefore Docker Desktop) cannot start at all (`wsl --install` fails with
> `HCS_E_HYPERV_NOT_INSTALLED`). The integration and authenticated-e2e layers
> **self-skip locally** and are authoritative in CI
> (`.github/workflows/ci.yml`). Every `*.integration.test.ts` probes
> `SELECT 1` in `beforeAll` and downgrades its `it` to `it.skip` when the DB is
> unreachable; `e2e/{authed,journey,failures,security}.spec.ts` gate on
> `E2E_AUTHED` + DB reachability the same way. Phase 27 confirmed the
> non-DB-dependent third of the e2e suite passes in full (61/61) and that the
> DB-gated two-thirds — including three new spec files — skip cleanly rather
> than erroring, but their seeded scenarios are **not yet verified against a
> real database** on this machine; that needs either virtualization enabled
> here or a CI run.

## Area coverage

| Area                    | Where                                                                                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication          | `auth/callbacks.test.ts`, `integrations/state.test.ts`, `security/rate-limit.test.ts` (magic-link throttle); e2e `api.spec.ts` (CSRF/providers endpoints), `ui.spec.ts` (form + failure state), `authed.spec.ts` (session cookie, revocation)                                                      |
| Signup                  | e2e `ui.spec.ts` (signup form renders); `journey.spec.ts` (full flow through to a seeded account, since real sign-in needs a mail transport); shares the auth path above                                                                                                                           |
| Login                   | e2e `ui.spec.ts` (magic-link form, invalid-email, send-failure), `authed.spec.ts` (signed-in dashboard)                                                                                                                                                                                            |
| Onboarding              | e2e `journey.spec.ts` — **fully real**: a zero-membership user is redirected to `/onboarding`, submits the form, and a real `Organization`/`Membership` are created (no seeding for this step)                                                                                                     |
| Logout                  | `authed.spec.ts` (session-revocation → re-login); e2e `journey.spec.ts` (real `UserMenu` → "Sign out" → session invalidated); NextAuth signout is framework-covered                                                                                                                                |
| Password recovery       | **N/A** — the product has no passwords (magic-link + Google OAuth only). The magic link _is_ the recovery path; `providers` endpoint test asserts `dev-credentials` is prod-off                                                                                                                    |
| Organizations           | `organizations/slug.test.ts`, `db/repositories.integration.test.ts` (membership + isolation + suspended), `security/tenant-isolation.integration.test.ts`, e2e `security.spec.ts` (cross-organization website/crawl/project/automation reads → 404)                                                |
| RBAC                    | `rbac/authorize.test.ts` (full matrix), `automation/rules.test.ts` (owner-permission refusal), `seo/agent-tools.test.ts` (org-scoped), e2e `authed.spec.ts` (VIEWER vs OWNER UI gating), `security.spec.ts` (VIEWER blocked from add-website/agent, MEMBER blocked from connecting an integration) |
| Billing                 | `billing/{checkout,entitlements,gateway,plan-change,plans,stripe-signature,subscription,webhook}.test.ts`, `billing/webhook.integration.test.ts` (real-DB dedupe + concurrent), e2e `api.spec.ts` (webhook 400/200/malformed)                                                                      |
| YouTube OAuth           | `integrations/{state,oauth-csrf,token-refresh}.test.ts`, e2e `api.spec.ts` (callback error params, connect requires session), `journey.spec.ts` (Connect → real authorize host, then a seeded connected state), `failures.spec.ts` (ERROR/REVOKED connection states)                               |
| YouTube synchronization | `youtube/{google-client,metrics,sync.integration}.test.ts`                                                                                                                                                                                                                                         |
| TikTok OAuth            | `integrations/tiktok-oauth.test.ts`, `integrations/oauth-csrf.test.ts` (TikTok branch), `tiktok/publish.test.ts` (authorized publish guardrails), e2e `journey.spec.ts` (Connect → real authorize host)                                                                                            |
| TikTok synchronization  | `tiktok/{display-client,sync.integration}.test.ts`                                                                                                                                                                                                                                                 |
| SEO crawling            | `seo/{ssrf,fetch,frontier,robots,sitemap,rate-limiter,url,crawler.integration}.test.ts`, e2e `journey.spec.ts` (a real crawl of a public URL, end to end through the UI), `failures.spec.ts` (invalid/private-IP URL rejected, BLOCKED crawl renders)                                              |
| SEO analysis            | `seo/{rules,scoring,page-eval,link-graph,recommendation-engine,ai-readability,audit-summary,agent,agent-tools,agent.integration}.test.ts`, e2e `failures.spec.ts` (zero issues, 2,000 issues within a time budget)                                                                                 |
| AI agent                | `agent/{orchestrator,planner,memory,conversations,tasks,orchestrator.integration}.test.ts`, `agents/grounding.test.ts`, e2e `journey.spec.ts` (a real chat turn end to end, deterministic mode), `failures.spec.ts` (aborted/500 agent-stream)                                                     |
| AI tools                | `seo/agent-tools.test.ts` (read-only, org-scoped, no write tool), `security/untrusted.test.ts` (prompt-injection fence)                                                                                                                                                                            |
| Content generation      | `content/{ingest,analyze,generate,assets,schemas,pipeline.integration}.test.ts`, e2e `journey.spec.ts` (create project → analyze → generate, end to end through the UI)                                                                                                                            |
| Reports                 | `reports/{build,sections,summary,generate,pdf,export,read,redact,share}.test.ts`, e2e `journey.spec.ts` (generate a report end to end through the UI)                                                                                                                                              |
| Notifications           | **N/A** — the `Notification` model is not implemented (ADR-0027); an SEO alert opens a `Task` instead. `dispatch.test.ts` covers that path                                                                                                                                                         |
| Tasks                   | `agent/tasks.test.ts`, `automation/dispatch.test.ts` (SEO alert / content opportunity → Task), e2e `journey.spec.ts` (promote a monetization opportunity to a real `Task` row through the UI)                                                                                                      |
| Automations             | `automation/{cron,rules,runner,dispatch,jobs}.test.ts`, `automation/idempotency.integration.test.ts` (real-DB duplicate + concurrent tick), e2e `security.spec.ts` (cross-organization automation-rule read → 404)                                                                                 |
| Admin                   | `observability/{admin-lists,admin-metrics,health,errors,scrub,metrics,worker-heartbeat}.test.ts`, e2e `smoke.spec.ts` (`/admin` → login), `api.spec.ts` (`/api/metrics` auth), `authed.spec.ts` + `security.spec.ts` (staff renders, normal user 302s to `/app` across five `/admin/*` sub-pages)  |
| Mobile UI               | e2e `smoke.spec.ts` + `ui.spec.ts` (375-px viewport, no horizontal overflow on every public page)                                                                                                                                                                                                  |

## Failure-scenario coverage (from the brief)

| Scenario                       | Where                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure states                 | `ui.spec.ts` (magic-link send failure), `billing/webhook.test.ts` (handler error → 500 + ledger FAILED), `reports/generate.test.ts` (FAILED path), `automation/runner.test.ts` (dispatch throws), e2e `failures.spec.ts` (aborted/500 agent-stream, ERROR/REVOKED OAuth connection, BLOCKED crawl)                                                                                        |
| Empty states                   | `authed.spec.ts` (`/app/automations` empty heading), `reports/read.test.ts` / `agent/conversations.test.ts` (empty lists), e2e `failures.spec.ts` (a freshly onboarded org across seven `/app/*` pages, an empty website, a zero-issue crawl)                                                                                                                                             |
| Network failures               | `youtube/google-client.test.ts` (retry transient 5xx then throw), `tiktok/display-client.test.ts` (rate-limit backoff), `seo/fetch.test.ts` (timeout / network reasons), e2e `failures.spec.ts` (an aborted agent-stream request recovers the UI)                                                                                                                                         |
| Expired OAuth tokens           | `integrations/token-refresh.test.ts` (6 cases: refresh expired, skip valid, mark ERROR on failure, refuse REVOKED, no-refresh-token, provider dispatch), e2e `failures.spec.ts` (a REVOKED connection prompts reconnect in the UI)                                                                                                                                                        |
| API rate limits                | `security/rate-limit.test.ts` (fixed-window, block, per-key, **fail-open**), e2e `api.spec.ts` (`/api/health` burst → only 200/429, never 5xx)                                                                                                                                                                                                                                            |
| Malformed external data        | `seo/{html,robots,sitemap}.test.ts`, `youtube/google-client.test.ts` / `tiktok/display-client.test.ts` (non-JSON / typed errors), `billing/webhook.test.ts` (unknown event type → SKIPPED), e2e `api.spec.ts` + `failures.spec.ts` (non-JSON / bad-signature webhook body → <500)                                                                                                         |
| Concurrent jobs                | `automation/jobs.test.ts` (second sweep in the same window claims nothing), `automation/idempotency.integration.test.ts` (3 concurrent `claimRun` → exactly one row)                                                                                                                                                                                                                      |
| Duplicate webhook delivery     | `billing/webhook.test.ts` (replay → `deduped`; P2002 on concurrent insert), `billing/webhook.integration.test.ts` (real-DB replay + concurrent → one row)                                                                                                                                                                                                                                 |
| Duplicate automation execution | `automation/runner.test.ts` (`claimRun` idempotency), `automation/idempotency.integration.test.ts` (real `@@unique` blocks the second tick)                                                                                                                                                                                                                                               |
| Tenant isolation               | `db/repositories.integration.test.ts`, `security/tenant-isolation.integration.test.ts` (report / automation / conversation cross-tenant reads → null / `resource_not_found`; a same-org user still can't read another user's conversation), e2e `security.spec.ts` (website/crawl/content-project/automation-rule cross-org reads → 404, never the other org's data in the response body) |
| Unauthorized access attempts   | `rbac/authorize.test.ts`, `integrations/oauth-csrf.test.ts` (session-bound callback), e2e `smoke.spec.ts` (every `/app/*` + `/admin` → `/login`), `api.spec.ts` (metrics 403, agent-stream never streams unauth, connect requires session), `security.spec.ts` (an authenticated VIEWER/MEMBER blocked by role, not just an anonymous caller)                                             |
| Invalid input (SSRF-adjacent)  | `seo/ssrf.test.ts` (the exhaustive unit matrix — `docs/CRAWLER-SECURITY-AUDIT.md`), e2e `failures.spec.ts` (a private-IP website URL rejected as a form error through the real UI, not just at the service layer)                                                                                                                                                                         |
| Large datasets                 | e2e `failures.spec.ts` (a 2,000-issue crawl page renders within a generous time budget — a live regression guard, not a unit-level count check)                                                                                                                                                                                                                                           |

## Known residuals

- Authenticated e2e mints the NextAuth JWE cookie directly (magic-link needs a
  mail transport; dev-credentials is prod-disabled by Phase 14). It runs only in
  CI, where Postgres and a matching `AUTH_SECRET` fallback are present.
- Redis is not provisioned in CI, so the rate limiter's _runtime_ effect is
  proven by unit tests (mocked Redis) + the fail-open path; the e2e health-burst
  test only asserts "no 5xx".
- **Phase 27 added a real, full-journey e2e pass** (`e2e/journey.spec.ts`,
  `failures.spec.ts`, `security.spec.ts` — see `docs/E2E-TESTING.md`) that
  closes the "deep data-flow e2e is left to the integration layer" residual
  this section used to name — a real crawl, a real chat turn, real content
  generation, and a real report are now driven end to end through the UI. It
  also found and fixed a real bug: `/api/health` 500'd under the exact boot
  configuration this suite (and CI) already used
  (`docs/E2E-TESTING.md`, ADR-0042). **Not yet verified on this machine**:
  Docker Desktop cannot start here — virtualization is disabled in this
  machine's firmware — so the three new spec files are confirmed structurally
  sound (they compile, and skip cleanly without a database) but their seeded
  scenarios are unverified against a real Postgres pending either that
  firmware setting or a CI run.
- Real Google/TikTok/Stripe consent screens and checkout are never
  automated (no live credentials; doing so would violate those providers'
  policies) — `journey.spec.ts` verifies the "Connect" buttons reach the real
  provider's authorize host and that a billing plan-change CTA is correctly
  disabled without Stripe configured, and seeds the _connected_/_paid_ row
  state directly where a real flow can't be driven.
