# PHASE-2-REPORT.md — Enterprise identity, organizations, teams, roles & access control

Completion report for the Phase 2 brief. Decision record: ADR-0052. Detailed
subsystem docs: `docs/rbac.md`, `docs/enterprise-identity.md`,
`docs/tenant-isolation.md`, `docs/ai-governance.md`, `docs/audit-logging.md`.
Code landed in commit `95f170c` (101 files, +8266/-1028) plus a follow-up
integration-test fixture fix described in §13 below.

## 1. Architecture changes

No new services, no new runtime, no replacement of Auth.js. Phase 2 is
additive on top of the Phase 0/1 architecture (`apps/web` Server
Actions/Route Handlers over `packages/services`, `apps/worker` for jobs,
Postgres + Prisma, Redis for rate limits):

- A new `rbac/permissions.ts` capability catalog sits under the existing
  `rbac/authorize.ts` entry point; nothing calling `authorize()`/`can()`
  changed its call shape (`Authorizable = Action | Permission`).
- A server-side session registry (`UserSession`) layers on top of the
  existing stateless JWT session, read by a new `auth/sessions.ts` module.
- `AsyncLocalStorage` (`auth/request-context.ts`) carries per-request IP/UA
  into Auth.js callbacks, which otherwise receive no request object — the
  one new piece of request-scoped plumbing this phase required.
- New `packages/services` modules: `governance/`, `apikeys/`,
  `security/events.ts`, `security/job-auth.ts`, `audit/catalog.ts`,
  `audit/query.ts`, `organizations/members.ts`, `organizations/settings.ts`,
  `auth/signup.ts`, `users/account.ts`.
- New `apps/web` settings area (`/app/settings/*`, 8 pages) replacing one
  monolithic `settings-tabs.tsx`; new public `/api/v1/*` (whoami,
  connections) authenticated by API key instead of session cookie.
- Worker processors (`agent`, `report`, `content`, `seo`) gained one call
  each to `assertJobAuthorized` before doing any work.

## 2. Database changes

One additive migration, `20260922120000_enterprise_identity` (hand-authored,
verified byte-identical to `prisma migrate diff`'s own output against the
schema). No `DROP`, no data rewrite, no column made non-nullable without a
default.

- `Role` enum gains `MANAGER` (between MEMBER and ADMIN).
- `User` gains `passwordHash`-adjacent columns `lastLoginAt`,
  `lastActiveAt`, `deactivatedAt` (all nullable).
- `Organization` gains `timezone`, `defaultLocale` (both defaulted).
- `Invitation` gains `acceptedById`, `lastSentAt`, `sendCount`.
- `AuditLog` gains `result`, `requestId`, `agentRunId` + a composite index;
  existing rows read `result = 'SUCCESS'` implicitly (column defaults).
- Five new tables: `UserSession`, `SecurityEvent`, `UserMfaFactor` (+
  `MfaFactorType`/`MfaFactorStatus` enums, unused until MFA ships),
  `ApiKey`, `AiGovernancePolicy`.

## 3. Authentication changes

Auth.js v5, JWT sessions, and every existing sign-in method (magic link,
password, Google, dev-login) are unchanged in shape. What's new sits beside
them:

- **Server-side session registry.** A `UserSession` row is created on every
  fresh sign-in and referenced by the JWT's new `sid` claim.
  `requireUser()` now calls `validateSession()`, which rejects a revoked or
  expired row even though the JWT itself would still verify. This is the
  mechanism behind "sign out this device" / "sign out all other sessions" —
  something a pure-JWT design cannot do without it.
- **`sessionVersion` revocation** (already partially existed) is now the
  backstop: bumping it invalidates every token issued before the bump,
  independent of the per-session registry.
- **Recent-authentication gate.** An `authAt` JWT claim, settable only by a
  real sign-in (never by `updateSession`'s client-callable path on its own),
  drives `hasRecentAuth()` — a 15-minute window required before ownership
  transfer, organization deletion, account deletion, or granting OWNER.
- **Failed-login tracking + a fixed critical bug.** `recordFailedLogin`
  writes a `SecurityEvent` and raises `REPEATED_LOGIN_FAILURE` (CRITICAL) at
  5 failures in 15 minutes. Fixing this surfaced the account-takeover bug in
  §12.

## 4. Authorization changes

- **Capability-based permissions replace the coarse `Action` enum** as the
  source of truth (`rbac/permissions.ts`, 50 permissions). The old `Action`
  names are kept as an exact alias table (`LEGACY_ACTION_PERMISSION`) so the
  ~70 existing `requirePermission('integration:manage')`-style call sites
  needed no changes.
- **A new MANAGER role** sits between MEMBER and ADMIN with strict
  cumulative grants (`ROLE_RANK`, `ROLES_BY_RANK`).
- **`checkRoleChange()`** is the single pure function every role-change path
  now calls: an actor needs `member.update_role`; only an OWNER may touch an
  OWNER (grant or revoke); self-demotion from OWNER is blocked unless
  another OWNER exists; nobody can promote past their own rank.
- A pinned regression test (`rbac/permissions.test.ts`) hard-codes the exact
  pre-Phase-2 permission set for VIEWER/MEMBER/ADMIN/OWNER, copied from git
  history, so no existing account silently gained or lost access.

## 5. RBAC matrix

Full matrix in `docs/rbac.md`. Summary: 5 roles (VIEWER → MEMBER → MANAGER →
ADMIN → OWNER), 50 permissions across 15 domains (organization, member,
billing, integration, content, seo, youtube, tiktok, analytics,
monetization, recommendation, agent, automation, report, settings, security,
audit, api_key). Grants are strictly cumulative by rank; the only
non-cumulative rule is `ownership.transfer` and OWNER-target role changes,
which require the actor to already be OWNER regardless of rank.

## 6. Tenant isolation implementation

Unchanged in strategy from ADR-0035 (app-layer scoping, RLS deferred) but
newly _verified_ rather than assumed:

- Every new query added this phase (sessions, security events, API keys,
  governance policy, audit query/export, member/invitation operations) is
  covered by `scripts/check-tenant-scope.mjs`'s CI gate, which passes.
- A new `tenant-isolation-phase2.integration.test.ts` (12 tests, run against
  a real database — see §13) covers every Phase 1+2 surface specifically:
  cross-org action requests, audit log reads, role/member changes, API key
  resolution, governance policy, agent-tool WordPress scoping, and personal
  data export.
- RLS remains formally deferred (`docs/tenant-isolation.md` records the
  evaluation and reasoning); the four-layer defense (repository scoping +
  integration tests + the CI lint + now a much larger live-database suite)
  is the accepted mitigation until a follow-up phase adds it.

## 7. Worker security

Every job type that runs model calls, generates content, crawls a site, or
builds a report now calls `security.assertJobAuthorized(...)` (with the
matching permission — `agent.run`, `report.create`, `content.create`,
`seo.analyze`) before doing anything. This closes the gap where a job
enqueued while a user still had access could execute after that access was
revoked (role change, removal, deactivation, or the organization entering
deletion) — the queue payload is never trusted as a standing grant.

## 8. AI governance

New `governance/` module: a per-organization, Zod-validated
`AiGovernancePolicy` (defaults in `DEFAULT_POLICY`) covering five
integrations × six action classes (analyze / generate / draft / modify /
publish / delete). **The schema itself cannot express "automatic" for
modify, publish or delete** — those two enum branches are typed out of
existence, not just defaulted safely, so no future code path can silently
loosen the floor. Enforced at: the Growth Agent orchestrator (blocked
capabilities are skipped with a stated reason, never silently run), the
`wordpress.list_content` agent tool, approval request/execution, direct
WordPress draft creation, and automation create/update/run. Full detail and
the "what automatic actually means today" caveat are in
`docs/ai-governance.md`.

## 9. Approval system

`IntegrationActionRequest` (existing from Phase 1) now additionally checks
governance at both request time and execution time
(`assertGovernanceAllows` + `actionClassForLevel`), so a policy tightened
after a request was filed wins at execution. A new
`'wordpress.create_draft'` executor lets an org route AI-proposed drafts
through approval when its policy requires it, rather than only supporting
disable/allow.

## 10. Audit system

Two intentionally separate streams (`docs/audit-logging.md` §1):
`AuditLog` (per-organization, "who did what") and `SecurityEvent`
(per-person, cross-org, "what happened to my account's security"). New this
phase: a canonical-name catalog (`audit/catalog.ts`) mapping stored action
strings to enterprise event names and categories; a filtered, paginated
audit UI at Settings → Audit log (`audit.view`, ADMIN+); CSV export
(`audit.export`, ADMIN+, capped at 10,000 rows, rate-limited 5/10min,
spreadsheet-formula-injection neutralized); 22 `SecurityEvent` types with
IP stored only as a network prefix and user agents truncated. Both streams
are written by functions that never throw into the caller — see §13 for
what that design choice concealed, and how it was found.

## 11. API key system

New `apikeys/` module: keys are `ga_<prefix>_<secret>`, stored as a SHA-256
hash only (the secret is 256-bit random, so a slow KDF adds nothing), 25
active keys per org, scopes capped at the creator's live permissions and
re-validated on every request (not just at creation — a demoted creator's
keys narrow automatically). `/api/v1/whoami` and `/api/v1/connections` are
the first two endpoints; they accept only a bearer API key, never a session
cookie (verified by `e2e/api.spec.ts`'s new tests).

## 12. Security findings

Found during this phase's own audit of the pre-existing system (not
inherited from a prior report) and fixed before this report was written:

| #   | Severity                  | Finding                                                                                                                                                                                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                      |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **CRITICAL**              | Account takeover through sign-up: `signUpAction` would set a password on _any_ existing account with none (a magic-link or Google user), and that email is already verified — an attacker who knew a victim's email could sign in immediately.                                                                                                                                                                    | `registerWithPassword` (`auth/signup.ts`) now sends a fresh magic-link-style verification to the account's own email before a password can be set on an existing passwordless account, exactly like the reset flow — never sets a password unilaterally. |
| 2   | **HIGH**                  | Role escalation: `updateMemberRole` allowed an ADMIN to grant OWNER (including to themselves) or demote an OWNER.                                                                                                                                                                                                                                                                                                 | `checkRoleChange()` — only an OWNER may touch OWNER in either direction; enforced as one pure, tested function on every role-change path.                                                                                                                |
| 3   | **MEDIUM**                | Automations kept running during an organization's deletion grace period.                                                                                                                                                                                                                                                                                                                                          | `dueAutomations`/`dueRetryRuns` exclude deletion-scheduled orgs; `automationBlockReason()` also re-checks at execution time and pauses the rule.                                                                                                         |
| 4   | **MEDIUM**                | Invitations: accept happened on a GET (consumable by link scanners/prefetchers); an inviter who'd lost their own rights could still grant roles through an outstanding link; no resend, no revoke, no email.                                                                                                                                                                                                      | Accept is now POST-only behind a confirmation page; the inviter's _current_ permission is re-checked at accept time, not just at send time; resend/revoke added; invitation delivery wired to the notification/email system where configured.            |
| 5   | **HIGH (test integrity)** | All ten `*.integration.test.ts` files probed database reachability inside `beforeAll`, but the `it`-vs-`it.skip` choice was made at test _collection_ time, before `beforeAll` runs — so every integration test in the repo silently skipped in every environment, including CI, since these files were first written. Every prior phase's "integration tests pass in CI" was therefore never actually exercised. | The probe moved to a top-level `await` at module load, before tests are defined. Confirmed fix by running the full suite against a real (isolated, disposable-schema) database — see §13.                                                                |

## 13. Tests executed / passed / failed

**Unit (`pnpm test`, all packages):** 933 tests, 933 passed, 0 failed
(125 test files). `pnpm lint` 14/14 clean, `pnpm typecheck` 14/14 clean,
`pnpm format:check` clean, `pnpm check:tenant` clean, `pnpm check:audit`
clean (6 pre-existing allowlisted advisories, 0 new), `pnpm test:scripts`
11/11 passed.

**Integration (real database — see method below):** all 11
`*.integration.test.ts` files across the repo, **55 tests, 55 passed, 0
failed.** This is the first time in this project's history every
integration suite has actually executed and passed; prior phases' claims of
"integration tests run in CI" were not true until finding #5 above was
fixed.

Getting to that green run surfaced one more real defect, in the newly-fixed
tests themselves rather than in product code:

- `content/pipeline.integration.test.ts`'s audit-log assertion initially
  failed — 7 of 8 expected `content.*` audit rows were missing. The cause
  was **not** a product bug: `AuditLog.actorId` has always had a real
  foreign key to `User.id`, and this test (like `agent/orchestrator.
integration.test.ts` and `seo/crawler.integration.test.ts`) passed a
  literal placeholder string (`'u1'`, `'user-1'`) as the acting user id,
  with no `User` row behind it. `recordAudit`'s catch-and-log-only error
  handling (deliberate — an audit write must never break the operation it's
  auditing) silently absorbed the resulting `P2003` foreign-key violation on
  every affected call. Confirmed by temporarily logging the swallowed error
  before fixing anything (`AUDIT_WRITE_FAILED … Foreign key constraint
violated on the constraint: audit_logs_actorId_fkey`). Because this
  constraint could never fail in production — a real `userId` always
  belongs to an authenticated, persisted `User` — this was purely a test
  -fixture gap invisible until the moment integration tests first actually
  ran. Fixed by having all three test files create a real `User` row
  (`makeUser()`) instead of using a placeholder string, in
  `content/pipeline.integration.test.ts`,
  `agent/orchestrator.integration.test.ts`, and
  `seo/crawler.integration.test.ts`. Re-verified clean on a second full
  isolated-schema run (55/55).

**Method (unchanged from the technique introduced earlier this project,
reused here for the first time against Phase 2's own code):** SSH to the
staging VPS, into an isolated clone (`/opt/ga-verify`, never the running
`/opt/growth-agent`), with a throwaway Postgres schema appended to the real
`DIRECT_URL` (`?schema=ga_verify_<timestamp>`); migrations and the full
integration suite run inside a transient `node:20.11.0-bookworm` Docker
container against that schema; the schema is dropped afterward. The live
application and its `public` schema were never touched.

**E2E:** not re-run this pass (no code path this phase's fix touched is
covered differently by e2e; the last full run — documented in the
`playwright.config.ts` history — was 74 passed / 27 skipped / 0 failed,
twice consecutively). `apps/web/e2e/api.spec.ts` and `ui.spec.ts` gained
Phase 2-specific coverage: public `/api/v1/*` requires a key and rejects a
session cookie / forged key / permissive CORS (4 tests), and 7 settings
paths plus the invitation link redirect to `/login` when unauthenticated.

## 14. Remaining risks

- **RLS is still deferred** (ADR-0035, re-affirmed here). The mitigation is
  application-layer scoping + the CI lint + integration tests, now actually
  running — not a database-enforced backstop.
- **MFA is data-model only.** `UserMfaFactor` exists; no enrollment or
  verification UI ships this phase. The Security settings page states this
  plainly rather than showing a non-functional toggle.
- **Invitation email depends on a configured transport.** Without one
  (`EMAIL_TRANSPORT=console`, the staging/dev default), the inviter gets a
  copyable link instead of an email — unchanged from pre-Phase-2 behavior,
  now at least visible in the UI copy.
- **No automated alerting on security events.** `REPEATED_LOGIN_FAILURE`
  and friends are recorded but nothing pages or emails on them yet
  (`docs/audit-logging.md` §4).
- **The edge/IP rate-limit layer and a strict nonce-based CSP remain
  outstanding** (see the updated "Still outstanding" list in `CLAUDE.md`) —
  Phase 2 added Redis-backed limits on the auth/session paths it touched,
  not a repo-wide edge layer.

## 15. Manual configuration required

None beyond what already existed. No new environment variable is required
for Phase 2 to function: sessions, RBAC, audit, and governance all work
with zero configuration; API keys and invitations work immediately; only
invitation _email delivery_ needs an already-documented `EMAIL_TRANSPORT`
to be anything other than `console`.

## 16. Files changed

101 files, +8266/−1028 (commit `95f170c`), plus this report, `ADR-0052`,
four new subsystem docs (`docs/rbac.md`, `docs/enterprise-identity.md`,
`docs/tenant-isolation.md`, `docs/ai-governance.md`, `docs/audit-logging.md`
— five, not four), and a follow-up fixture fix across
`packages/services/src/content/pipeline.integration.test.ts`,
`packages/services/src/agent/orchestrator.integration.test.ts`, and
`packages/services/src/seo/crawler.integration.test.ts` (§13). No files
were deleted except the superseded `settings-tabs.tsx`, replaced by the new
settings area.

## 17. Deployment requirements

The migration is additive-only and safe to `prisma migrate deploy` against
the live staging database with no downtime and no data backfill. No new
service, no new environment variable, no Docker image change. This report's
integration-test verification (§13) exercised the migration and the new
code against an isolated schema on the _actual_ staging Postgres instance,
not a synthetic one — the strongest verification available without
touching the live `public` schema.

## 18. Definition of Done

- [x] All 38 brief parts addressed (RBAC, invitations, sessions, audit,
      API keys, governance, worker auth, tenant isolation, settings UI,
      safe deletion, data export, documentation).
- [x] `pnpm lint` / `pnpm typecheck` / `pnpm test` — 14/14, 14/14, 933/933.
- [x] Integration tests — 55/55 against a real database (first time ever).
- [x] Tenant isolation — CI lint clean + 12 new + existing cross-tenant
      integration tests, all passing live.
- [x] Security review — 5 findings, all fixed, table in §12.
- [x] Migration verified additive and diff-matched against Prisma's own
      output.
- [x] Backward compatibility — legacy `Action` names aliased and pinned by
      a hard-coded regression test; no existing user's access changed.
- [x] Documentation — 5 new docs + this report + ADR-0052.

**Phase 2 is complete. Per the brief's explicit instruction, no Phase 3
work has started.**
