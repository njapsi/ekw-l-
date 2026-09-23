# PHASE-12-REPORT.md

**Growth Agent — Phase 12: Enterprise Security, Reliability, Governance &
Production Hardening.** Full change log and closing report. See
`docs/SECURITY_POSTURE.md` for the posture statement and risk register,
`docs/INCIDENT-RESPONSE.md` / `docs/DISASTER-RECOVERY.md` for the new
runbooks, and ADR-0061 (`docs/DECISIONS.md`) for the architectural
reasoning behind each decision below.

## 1. Executive summary

Phase 12's brief asked for a from-scratch security/reliability/governance
audit and hardening pass across essentially every domain, with an explicit
instruction to inspect before implementing, harden what exists rather than
rebuild it, and never fabricate a test result. Four parallel audits found
that most of the brief's asks were already mature, real, and previously
audited (Phases 14/18/24/25/31) — the genuine, closed gaps were: MFA
(100% unimplemented, now real), a rate limiter with no fail-closed option
anywhere (now has one, applied narrowly and deliberately), Growth Missions
with no kill switch (now has one), a CI tenant-scope lint that had silently
stopped covering 21 models introduced since it was written (now fixed), a
real concurrency bug in the research-project dispatch path (now fixed), and
one-paragraph incident-response/disaster-recovery documentation (now ten
real runbooks plus a dedicated DR document). No numeric security score is
given anywhere in this phase's output, per its own explicit instruction; see
`docs/SECURITY_POSTURE.md`'s category-verdict table instead.

## 2. Scope and constraints honored

Phase 12 only. Did not start Phase 13 (billing/usage/entitlements/enterprise
plans) or Phase 14 (final certification/launch readiness). Did not
redesign the application, rebuild the AI runtime/memory system/integration
architecture, or replace the authentication architecture — MFA was added
*alongside* the existing sign-in flow, not instead of it (ADR-0061 §1). No
new billing feature was added beyond what protects the existing billing
system (none was needed — billing's own metering/authorization was found
intact from Phases 23/31 and not touched). No test was disabled to make the
build pass; the one flaky test encountered (`missions/crud.test.ts`, a
5-second timeout under system load) was confirmed flaky by re-running in
isolation, not silenced.

## 3. Methodology

Four parallel background audit agents, each scoped to a non-overlapping
domain (auth/session/MFA; AI/mission safety; infrastructure/ops;
tenant-isolation/worker-reliability), each required to cite exact
file:line evidence and classify every sub-item as ALREADY DONE / PARTIALLY
DONE / NOT DONE AT ALL before any code was written. This avoided
re-discovering or duplicating the substantial mature infrastructure these
audits confirmed (session management, the approval queue, the Tool
Registry/Policy Engine, the crawler's SSRF defenses, webhook idempotency,
AI prompt-injection fencing) and focused implementation effort on the
genuine gaps below.

## 4. What was found already solid (verified, not rebuilt)

- Server-side session registry with real per-device revocation
  (`UserSession`, `revokeSessionByHandle`/`revokeOtherSessions`).
- A mature approval queue with exactly-once execution and payload replay.
- Governance policy whose schema cannot express an unsafe default
  (automatic modify/publish/delete is untypeable, not just undefaulted).
- The crawler's SSRF defenses (75 tests, adversarially proven in Phase 24).
- Webhook idempotency (event-id ledger + id-keyed upserts).
- Universal prompt-injection fencing across ~14 model-facing prompts.
- The capability-based RBAC catalog and its role-escalation invariant.

## 5. Fixes implemented

### 5.1 Multi-factor authentication (new)

`packages/services/src/auth/mfa.ts` — hand-rolled RFC 6238 TOTP
(`node:crypto` HMAC-SHA1, no dependency) and one-time recovery codes.
Two-step enrollment (generate → verify with one live code → activate +
issue 10 recovery codes); the secret is sealed with the existing
AES-256-GCM envelope (`crypto/tokens.ts`), recovery codes are SHA-256
hashed at rest. Disabling MFA or regenerating recovery codes requires
**both** a recent real sign-in and a live code — the GitHub/Google
double-check pattern. Wired into Settings → Security
(`apps/web/src/components/app/settings/mfa-panel.tsx`), replacing the
"Coming soon" placeholder. **15 new tests** (`auth/mfa.test.ts`), including
an independent reference-implementation cross-check of the TOTP math (not
just self-consistency), tenant/user isolation, recovery-code one-time-use,
and the full enable → use → regenerate → disable lifecycle. Deliberately
**not** wired into the sign-in flow itself (ADR-0061 §1, `RISK-AUTH-1`).

### 5.2 Security event + RBAC hygiene

- Wired the previously-dead `MAGIC_LINK_REQUESTED` security event type into
  the actual magic-link send path (`auth/config.ts`'s `signIn` callback).
- Centralized the one ad hoc `role === 'ADMIN' || role === 'OWNER'` check
  in `cancelApprovalAction` into a named RBAC permission
  (`approval.cancel_others`, granted ADMIN+), with a regression test
  confirming MANAGER/MEMBER/VIEWER are correctly excluded.

### 5.3 Rate-limit fail-closed option

`checkRateLimit` gained an opt-in `failClosed` flag (default unchanged:
fail-open). Applied to password login (`auth/providers.ts`) and
password-reset request (`auth-actions.ts`) — both pure credential-guessing
surfaces where an attacker triggering a Redis outage must not be handed
unlimited guesses. Magic-link send deliberately excluded (ADR-0061 §2). New
tests in `security/rate-limit.test.ts`; fixing them surfaced and fixed a
real, latent test-isolation bug (a mocked Redis client's `incr` method was
permanently overwritten by an earlier "simulate an outage" test and never
restored, silently corrupting any test that ran after it and depended on
real counting — the pre-existing "fails OPEN" test had the same bug and
only avoided detection by being the last `incr`-dependent test in the
file).

### 5.4 Growth Missions kill switch

`packages/services/src/missions/killswitch.ts` — `MISSIONS_HALT` /
`MISSIONS_HALT_ORG_IDS`, mirroring the crawler's `CRAWLER_HALT` exactly.
Checked in both `runMissionTick` (the scheduled sweep) and
`runMissionTaskManually` (a human explicitly running one task) — a switch
a user could route around by clicking a button would not be a real kill
switch. 2 new tests in `missions/loop.test.ts`.

### 5.5 Mission/AI-safety hardening batch

- **Per-mission AI budget enforcement**: `enforceAiBudget` is now called
  before the planner's optional narrative-refinement model call and before
  `delegateSeoTask`'s `seo.agent.analyze` dispatch — previously never
  called anywhere in the missions module, a real, if narrow, metering gap.
- **`maxRetries` wiring**: `MissionLimitsSchema`'s `maxRetries` field was
  parsed but never actually passed to `MissionTask.create` — every task
  silently used the Prisma column default instead of the mission's
  configured value. Fixed.
- **Server-side replan throttle**: `planMission` now rate-limits
  (10/hour/mission) at the service layer, not just wherever a caller
  happens to add a check.
- **Deadline and weekly-limit stop conditions wired**: `maxDurationDays`
  (measured from `activatedAt`, independent of any `targetDate`) and
  `maxPublishPerWeek`/`maxContentGenerationsPerWeek` (a trailing 7-day
  window, classified via the Tool Registry's existing `category` field —
  `ACTION` = publish-shaped, `GENERATION` = content-generation-shaped, no
  new tool-name list invented) are now real, enforced stop conditions.
  Weekly limits deliberately do **not** hard-stop the whole mission (they
  are self-resetting by nature) — only the throttled category of task is
  filtered out of that tick's selection.
- **Task-claim idempotency**: `executeTaskAndRecord`'s task claim changed
  from an unconditional `update` to a conditional `updateMany` (status
  precondition), closing a race where two overlapping ticks could both
  claim and execute the same task.
- **`toolCallCount` accuracy**: previously only incremented on the success
  path; now increments on success, requires-approval, and failure alike
  for any task that made a real tool call.
- **Tool-execution timeout**: `executeAgentTool` now races its dispatch
  against a configurable deadline (`AGENT_TOOL_TIMEOUT_MS`, default 45s),
  surfacing a hung call as `UNAVAILABLE` instead of hanging the caller
  indefinitely — with an honest, disclosed caveat that this bounds the
  *caller's* wait, not the underlying call's actual execution (the same
  limitation `packages/ai`'s own tool-calling loop already has, for the
  same reason: no universal cancellation primitive exists for every branch
  a tool dispatch can take).
- **Research-project dispatch idempotency**: `runResearchProject`'s
  "check status, then transition" pattern replaced with an atomic
  `updateMany` claim, closing the same class of race the mission-task fix
  above closes. New concurrent-run regression test confirms exactly one
  execution for two simultaneous calls against the same project.

Net effect on `packages/services`' test suite: **1356 → 1376 tests**
(+20), all passing.

### 5.6 CI tenant-scope lint gap

`scripts/check-tenant-scope.mjs`'s `TENANT_MODELS` allowlist had not been
updated since it was written — 21 tenant-scoped models introduced across
Phases 1, 2, 5, and 6-10 (`agentRunEvent`, `apiKey`, `auditLog`,
`growthMission`, `integrationActionRequest`, `integrationSyncRun`,
`invitation`, `mcpServer`, `mcpServerTool`, `membership`, `missionEvent`,
`missionLearning`, `missionMetric`, `missionMilestone`, `missionTask`,
`tikTokContentPlan`, `tikTokExperiment`, `tikTokOpportunity`,
`wordPressContent`, `wordPressSite`, `youTubeCalendarEntry`,
`youTubeExperiment`, `youTubeOpportunity`) had been silently unchecked by
this CI gate the entire time. Adding them surfaced exactly two hits: one
real, low-risk gap in `missions/planner.ts` (fixed by adding the missing
`organizationId` filter), and one correct false positive in
`organizations/lifecycle.ts` (a user-deletion purge that must span every
org the user belongs to by design — marked with the linter's own
documented opt-out comment). `securityEvent` and `errorEvent` are
deliberately **not** added — both are person-/platform-centric and
legitimately cross-organization by design.

### 5.7 BullMQ retry configuration

All 9 named queues previously had **zero** `defaultJobOptions` — BullMQ's
own default is `attempts: 1`, meaning no job anywhere in this system
automatically retried a transient failure. Added `STANDARD_JOB_OPTIONS`
(exponential backoff) to every queue, and a separate `CRAWL_JOB_OPTIONS`
for the SEO crawl queue reflecting its longer-running job shape.

### 5.8 Readiness endpoint

`GET /api/health/ready` (new) reuses the existing `runHealthChecks` logic
but returns a real `503` when the aggregate status is `down`, for a caller
that gates on HTTP status alone. The existing `/api/health` is unchanged —
its "always 200, liveness-only" contract is depended on by
`Dockerfile.web`'s `HEALTHCHECK` and both compose files' healthchecks, and
changing it would have been exactly the kind of regression this phase's
own brief prohibits ("do not break existing functionality").

### 5.9 Redis-AUTH requirement in strict env validation

`scripts/check-env.mjs`'s `redis` validator now requires userinfo (a
password) in `REDIS_URL` when running in strict/production mode, mirroring
the existing TLS (`rediss://`) requirement exactly, with the same
`--allow-insecure` escape hatch for staging. One new test in
`check-env.test.mjs` (12/12 passing); `.env.example` and
`.env.staging.example` already had a credentialed Redis URL, so no
fixture needed updating.

### 5.10 Container hardening (template only)

`cap_drop: [ALL]` + `security_opt: ['no-new-privileges:true']` added to
both `web` and `worker` in `docker-compose.production.yml`. Verified safe
for the worker specifically because its Chromium instance already launches
with `--no-sandbox` (confirmed in `apps/worker/src/seo/playwright-renderer.ts`),
meaning it doesn't rely on the Linux capabilities a fully-capability-dropped
container would remove. **Deliberately not applied to
`docker-compose.staging.yml`** — staging is live, deployed infrastructure
this session has no way to redeploy or verify against; pushing an
unverified capability change to a running system is a materially different
risk than the same change to a never-deployed template (ADR-0061 §6,
`RISK-INFRA-1`).

### 5.11 Documentation

- `docs/SECURITY.md` — extended with MFA (§2), CORS as an explicit decision
  (§6), the RLS lint-gap fix (§3), fail-closed rate limiting and the new
  readiness endpoint (§8), the Growth Missions kill switch (new §9b), and a
  real pointer to the new incident-response/DR documents (§15, replacing
  the one-paragraph outline).
- `docs/INCIDENT-RESPONSE.md` (new) — ten real, step-by-step runbooks
  (OAuth token compromise, API key compromise, database compromise, AI
  provider key compromise, webhook secret leak, admin account compromise,
  `ENCRYPTION_KEY` compromise, tenant data leak, crawler misuse, Growth
  Mission misuse), each following detect → contain → investigate →
  mitigate → recover → communicate → postmortem → preventive action, and
  naming the actual kill switches/revocation functions/admin pages this
  codebase has for each step. Explicitly disclosed as a paper exercise,
  never rehearsed live.
- `docs/DISASTER-RECOVERY.md` (new) — expands `docs/DEPLOYMENT.md` §18 with
  four additional scenarios (bad migration, application-level data
  corruption, TLS renewal failure, DNS failure/hijack) and states plainly,
  at the top, that no live restore drill has ever been executed against
  this project's backup script — a real, disclosed gap, not a fabricated
  "drill passed" claim.
- `docs/SECURITY_POSTURE.md` (new) — the posture statement this report's
  own §1 summarizes: an explicit disclaimer against overclaiming
  certification, an 18-category PASS/PASS WITH CONDITIONS/FAIL/NOT TESTED
  table (no numeric score), and a 10-item risk register (Risk / Severity /
  Likelihood / Impact / Current Control / Mitigation / Owner / Status) with
  no unresolved CRITICAL/HIGH risk hidden.
- ADR-0061 (`docs/DECISIONS.md`) — the architectural reasoning behind every
  decision in this report, including the three alternatives considered and
  rejected (wiring MFA into login now, making every rate limit fail closed,
  implementing RLS unverified).
- `CLAUDE.md` — this bullet, in the "Current state" list, and the "Still
  outstanding" list updated to reflect what Phase 12 closed and what it
  explicitly left open.

## 6. Tests added this phase

| File | New tests |
|---|---|
| `auth/mfa.test.ts` (new) | 15 |
| `security/rate-limit.test.ts` | 2 |
| `missions/loop.test.ts` | 2 |
| `missions/stop-conditions.test.ts` | 4 |
| `research/engine.test.ts` | 1 |
| `agent/tool-executor.test.ts` | 1 |
| `rbac/permissions.test.ts` | 1 |
| `scripts/check-env.test.mjs` | 1 |
| `apps/web/e2e/api.spec.ts` | 1 (new `/api/health/ready` describe block) |

## 7. Gates status

- `pnpm lint` — 14/14 clean.
- `pnpm --filter @growth-agent/services typecheck` — clean.
- `pnpm --filter @growth-agent/web typecheck` — clean.
- `packages/services` test suite — **1376/1376 passing** (up from 1356 at
  phase start).
- `node scripts/check-tenant-scope.mjs` — clean.
- `node scripts/check-env.test.mjs` (via `vitest run scripts/check-env.test.mjs`)
  — 12/12 passing.
- YAML syntax of `docker-compose.production.yml` validated (no live Docker
  in this sandbox to run `docker compose config` — same disclosed
  limitation as every phase since 27).
- `apps/web` e2e suite — not re-run in full this phase (no live Postgres in
  this sandbox); the new `/api/health/ready` test was written to the same
  DB-less-safe pattern the existing `/api/health` tests use.

## 8. Known limitations, disclosed not hidden

See `docs/SECURITY_POSTURE.md`'s risk register for the complete, current
list. In summary: MFA isn't wired into login; `PlatformStaff` doesn't
require MFA; Postgres RLS remains unimplemented (a concrete future design
is now sketched in ADR-0061 §5, still unbuilt); no restore drill has ever
been executed; the new incident-response runbooks have never been
rehearsed; `/admin` page views aren't individually audit-logged; no
security event pages a human yet; container hardening wasn't pushed to the
live staging deployment; `nodemailer` CVEs remain peer-locked (a
pre-existing, tracked item, unchanged this phase).

## 9. Recommended next phase

Per the brief's own §110 stop condition, this report does not recommend
*starting* Phase 13 or 14 — it recommends what Phase 13/14 (or an
interstitial phase) should prioritize when they do start, in rough risk
order: (1) a real restore drill against a throwaway Postgres instance,
turning `RISK-DR-1` from a guess into a measurement; (2) requiring MFA for
`PlatformStaff` accounts (`RISK-ADMIN-1`) — the smallest, highest-leverage
of the remaining MFA gaps; (3) a concrete RLS implementation plan executed
against a real, disposable Postgres instance, following ADR-0061 §5's
sketch; (4) wiring at least the highest-severity `SecurityEvent` types to
a real alert channel, closing `RISK-ALERT-1`.

## 10. Sign-off

Per the brief's explicit instruction: this document does not claim the
application is "fully secure" or "enterprise certified." It claims,
specifically, that the items in §5 above were implemented, tested at the
level described in §6-§7, and that everything not tested is named in §8
rather than assumed. **STOP** — Phase 13 and Phase 14 are not started.
