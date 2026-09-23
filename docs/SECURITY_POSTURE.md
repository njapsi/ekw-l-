# SECURITY_POSTURE.md

The Phase 12 ("Enterprise Security, Reliability, Governance & Production
Hardening") posture statement. This is a snapshot of **implemented controls,
tests performed, and known limitations** — it is deliberately not a
certification. Read `docs/PHASE-12-REPORT.md` for the full change log this
phase produced, `docs/INCIDENT-RESPONSE.md` and `docs/DISASTER-RECOVERY.md`
for the operational runbooks, and `docs/SECURITY.md` for the living,
per-control reference this document summarizes rather than replaces.

## Explicit disclaimer

**This application is not "fully secure." It is not "enterprise
certified."** No external audit, penetration test, or compliance
certification (SOC 2, ISO 27001, PCI, etc.) has been performed. Every
finding below comes from this codebase's own internal audits (Phases 14, 18,
24, 25, 31, and this one) — real, evidence-based work, but not independent
third-party validation, and this document does not claim it is. Where a
control is untested against live infrastructure (no Docker in this
sandbox — see below), that is stated plainly rather than assumed passing.
**External validation (a real penetration test, a real restore drill, a
real load test against production-representative traffic) is still
required before any claim of "production-ready for general availability."**

## What this phase did and did not do

Per its own brief: audited the existing security/reliability posture first,
then closed genuine gaps. It did **not** rebuild the AI runtime, the memory
system, the integration architecture, or the authentication architecture;
did not redesign the application; did not implement new billing features
beyond what protects the existing billing system; and stops here — Phase 13
(billing/usage/entitlements/enterprise plans) and Phase 14 (final production
certification/launch readiness) are explicitly **not** started.

---

## Architecture summary (for a reader who hasn't read the rest of `docs/`)

Next.js 15 App Router (`apps/web`) + a BullMQ worker (`apps/worker`) share
business logic through `packages/services`; Postgres via Prisma
(`packages/db`); Redis for jobs, cache, and rate limiting. Tenant isolation
is application-layer (every query scoped by `organizationId`), backed by a
CI static-analysis lint (`scripts/check-tenant-scope.mjs`) and an
integration-test suite, not database-level Row-Level Security (a known,
tracked gap — see the risk register). Auth is Auth.js (NextAuth v5) with
JWT sessions, three real sign-in methods (magic-link, password, Google) plus
a dev-only credentials provider, and now (Phase 12) real TOTP MFA as an
additive second factor. AI runs behind a provider-agnostic layer
(`packages/ai`) with per-call timeout/retry/fallback/kill-switch and a
closed, read-mostly tool allowlist — no model-driven arbitrary tool-calling
loop exists in the live orchestrator path.

## Threat model — what this phase specifically stress-tested

Per the brief's own framing: could a malicious user (a) escalate privilege,
(b) access another tenant's data, (c) exhaust the AI/crawler/mission
subsystems, (d) bypass approval gates on external actions, or (e) survive a
Redis/DB outage as an amplified attacker rather than a throttled one. Each
is addressed below by category.

---

## Category verdicts

Per the brief's own instruction: **no numeric score.** Each category is
**PASS**, **PASS WITH CONDITIONS** (real gaps exist, named, with an accepted
rationale or a tracked remediation), **FAIL** (a real, unresolved
deficiency), or **NOT TESTED** (this sandbox could not verify it).

| # | Category | Verdict | Basis |
|---|---|---|---|
| 1 | Authentication | PASS WITH CONDITIONS | Magic-link, password (salted scrypt, rate-limited, no enumeration oracle), Google OAuth, and now TOTP MFA + recovery codes are all real and unit-tested (15 new MFA tests, Phase 12). MFA is **not** wired into the sign-in flow itself — see risk register `RISK-AUTH-1`. Passkeys/WebAuthn remain unimplemented (reserved enum value only). |
| 2 | Authorization & tenancy | PASS WITH CONDITIONS | Capability-based RBAC (50 permissions, `rbac/permissions.ts`), a checked role-escalation invariant (`checkRoleChange`), and a CI tenant-scope lint now covering 21 previously-unchecked models (Phase 12 fix). Postgres RLS is **not implemented** — app-layer scoping + the lint + integration tests are the accepted backstop (ADR-0035, ADR-0061). |
| 3 | Secrets management | PASS | Env-only secrets, `NEXT_PUBLIC_*` allowlist, pino redaction, `scrubSecrets` on persisted/displayed free text, AES-256-GCM envelope for OAuth tokens with a rotation mechanism (`ENCRYPTION_KEY_PREVIOUS`). Verified via targeted `git grep` secret scan (Phase 31), not a dedicated tool (`detect-secrets`/gitleaks could not run in this sandbox). |
| 4 | OAuth & integrations | PASS WITH CONDITIONS | Session-bound OAuth callbacks, PKCE for TikTok, encrypted tokens, revoke-on-disconnect, resilience (retry/circuit-breaker) on WordPress/MCP/sync but **not** YouTube/TikTok/Search Console (a named, accepted gap, ADR-0051). |
| 5 | Web app hardening | PASS WITH CONDITIONS | CSP, HSTS, frame/clickjacking/MIME headers all present and e2e-tested. CSP's `script-src` still needs `'unsafe-inline'` (App Router hydration) rather than a strict nonce — a tracked follow-up, unchanged this phase. CORS is now an explicit, documented decision (Phase 12) rather than an implicit default — no functional change, just intent recorded. |
| 6 | SSRF / crawler | PASS | The most heavily adversarially-tested subsystem in this codebase (Phase 24 found and fixed one BLOCKER and two CRITICALs via live reproduction, not just inspection). Re-verified clean in Phase 31 (75 SSRF tests). Unchanged this phase. |
| 7 | Rate limiting & abuse | PASS WITH CONDITIONS | Redis-backed, previously universally fail-open. Phase 12 added an opt-in fail-closed mode for the two pure credential-guessing surfaces (password login, password-reset request) — deliberately **not** applied to magic-link send (see `docs/SECURITY.md` §8 for the reasoning: magic-link is the sole recovery path for passwordless accounts, so failing closed there trades a smaller abuse risk for a total-lockout risk). No repo-wide edge/IP layer exists yet (roadmap). |
| 8 | Background jobs & missions | PASS WITH CONDITIONS | Idempotent claims (conditional `updateMany`) across automation, missions, and (Phase 12) research-project dispatch — a real race was found and fixed this phase (`research/engine.ts`). Missions now have a kill switch (`MISSIONS_HALT`, Phase 12) mirroring the crawler's. No per-turn wall-clock timeout on a single mission tick (relies on the underlying tool's own timeout — a disclosed gap, unchanged). |
| 9 | Webhooks | PASS | Signature-verified before parsing, doubly-idempotent (event-id ledger + id-keyed upserts), a failure-rate metric + alert (Phase 31). Unchanged this phase; re-verified, not modified. |
| 10 | Billing & metering | PASS WITH CONDITIONS | Server-side-only enforcement, OWNER-gated mutations, AI budget exhaustion gates. Metering coverage was closed for several previously-unmetered AI call sites in Phase 23/31; not re-audited this phase (explicitly out of scope per this phase's own brief — Phase 13 owns billing). |
| 11 | AI-specific security | PASS | Closed tool allowlists, universal prompt-injection fencing (`wrapUntrusted` on all ~14 model-facing prompts), output-side secret scrubbing, forced-confirmation on every `external`-kind proposed action. Adversarially tested (Phases 22, 25 — 34+ tests). Unchanged this phase. |
| 12 | Audit logging | PASS WITH CONDITIONS | Broad audit coverage across auth/org/billing/integration/agent actions. A real, named gap: `/admin` page **views** are not individually audit-logged (only the actions the console surfaces are, at their own call sites) — material for the admin-account-compromise scenario in `docs/INCIDENT-RESPONSE.md` §6. |
| 13 | Admin console & observability | PASS WITH CONDITIONS | Read-only admin, four independent no-secrets-in-output layers, gated `/api/metrics`. Phase 12 added a real `/api/health/ready` with genuine non-200 status codes (the existing `/api/health` is deliberately always-200 liveness-only, unchanged). No paging/alerting on security events yet — detection today is a human noticing something (a named, material gap for incident response). |
| 14 | Data protection & compliance | NOT TESTED | Encryption in transit/at rest, DSR export/delete flows exist (Phase 19). GDPR 72-hour notification timeline is *documented* as a requirement in `docs/INCIDENT-RESPONSE.md` but this project has no legal function to actually exercise it against — not verifiable from inside a codebase. |
| 15 | Vulnerability management | PASS WITH CONDITIONS | `pnpm audit` + an allowlist gate in CI; SAST via ESLint. No CodeQL/Semgrep/Trivy run this phase (unavailable in this sandbox, same as Phase 31's disclosed limitation). `nodemailer` CVEs remain peer-locked (SEC-1, tracked since Phase 18/23). |
| 16 | Incident response & DR | PASS WITH CONDITIONS | Ten real, step-by-step runbooks now exist (Phase 12, previously one paragraph). **Never rehearsed as a live drill** — a paper exercise until a real drill happens (see risk register `RISK-IR-1`, `RISK-DR-1`). |
| 17 | Container / infra hardening | PASS WITH CONDITIONS | `cap_drop: [ALL]` + `no-new-privileges` added to the production compose template this phase (both services already ran non-root). **Not applied to the live staging deployment** in this pass — a deliberate choice to avoid an unverified change to running infrastructure without redeploy access this session (see risk register `RISK-INFRA-1`). `read_only: true` root filesystem remains out of scope (Chromium/Next.js runtime writes need verification against a real deployment first). |
| 18 | Multi-factor authentication | PASS WITH CONDITIONS | Real, tested TOTP + recovery codes (Phase 12, new this phase — previously 100% unimplemented). Gated behind a recent-auth **and** live-code double-check for disable/regenerate. Not required for any role, not wired into login itself, not required for `PlatformStaff` (see `RISK-AUTH-1`, `RISK-ADMIN-1`). |

---

## Risk register

Severities: **CRITICAL** (active, exploitable, high impact) / **HIGH**
(exploitable with some precondition, or high impact with low likelihood) /
**MEDIUM** (real but bounded) / **LOW** (hygiene / defense-in-depth). No
unresolved CRITICAL or HIGH risk is hidden here — the two found and fixed
during this phase's own audit work do not appear below because they were
closed before this document was written (see `docs/PHASE-12-REPORT.md`
for what those were).

| ID | Risk | Severity | Likelihood | Impact | Current control | Mitigation / next step | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| RISK-AUTH-1 | MFA is not enforceable at sign-in — a compromised password alone still signs in without a second factor even for a user who enabled MFA for sensitive-action gating | HIGH | Low (needs a password compromise first) | High (full account takeover) | MFA gates disable/regenerate and (existing) sensitive org actions via `hasRecentAuth`; login itself is single-factor | Wire a real two-step Credentials challenge into Auth.js — a materially larger change to a live, audited auth path; deliberately deferred this phase per the brief's own "do not replace the existing authentication architecture without first proving it is necessary" | Eng | Tracked, not started |
| RISK-ADMIN-1 | `PlatformStaff` accounts are not required to have MFA enabled | HIGH | Low | High (cross-tenant read access if the account is compromised) | Admin console is read-only, so a compromise cannot mutate data, but cross-tenant reads are still exposed | Require MFA enrollment as a precondition for `PlatformStaff` grant | Eng | Tracked, not started |
| RISK-RLS-1 | Tenant isolation is application-layer only; a missed `organizationId` filter is caught by lint/tests, not structurally prevented by the database | HIGH | Low (lint + tests catch it in CI today) | Critical if one ever ships | `check-tenant-scope.mjs` CI gate + integration test suite | `withTenant()` GUC-wrapper retrofit across ~320 call sites + `FORCE ROW LEVEL SECURITY`, needs a real DB to verify safely (ADR-0035, ADR-0061) | Eng | Tracked, not started |
| RISK-DR-1 | No restore drill has ever been executed against a real database | HIGH | Low | High (an unverified restore script under real pressure) | `pg-restore.sh` exists and is code-reviewed | Run one real drill against a throwaway Postgres instance; record actual elapsed time | Eng | Tracked, not started |
| RISK-IR-1 | Incident-response runbooks (this phase's new deliverable) have never been rehearsed as a live drill | MEDIUM | Low | Medium (execution risk during a real incident) | Ten written runbooks (`docs/INCIDENT-RESPONSE.md`) | Tabletop exercise once an on-call rotation exists | Eng/Ops | Tracked, not started |
| RISK-ADMIN-2 | `/admin` page views are not individually audit-logged | MEDIUM | Medium | Medium (limits forensic visibility into admin-account compromise) | Actions the console surfaces are audited at their own call sites; the read itself is not | Add a lightweight page-view audit event for cross-tenant admin reads | Eng | Tracked, not started |
| RISK-ALERT-1 | No security event pages a human; detection depends on someone noticing | MEDIUM | Medium | Medium (delayed detection, not prevention failure) | `SecurityEvent`/`ErrorEvent` rows are recorded and queryable | Wire `REPEATED_LOGIN_FAILURE` / `MFA_CHANGED` / high-severity events to an actual alert channel | Eng/Ops | Tracked, not started |
| RISK-INFRA-1 | Container hardening (`cap_drop`, `no-new-privileges`) applied to the production compose template but not the live staging deployment | LOW | Low | Low (defense-in-depth only; both services already run non-root) | Non-root user in both Dockerfiles (pre-existing) | Apply to staging on the next planned redeploy, verified live rather than pushed blind | Eng | Tracked, not started |
| RISK-VULN-1 | `nodemailer` CVEs remain, peer-locked by `next-auth@5.0.0-beta.32`'s version range | MEDIUM | Low (mitigated — no `raw`, single validated recipient) | Medium | Documented mitigations in place; `.audit-allowlist.json` entry | Bump when the `next-auth` peer range relaxes | Eng | Tracked, accepted for now |
| RISK-RATE-1 | No repo-wide edge/IP rate-limit layer; per-route limits exist but not a blanket layer | LOW | Low | Low | Per-route Redis limits on every sensitive endpoint named in `docs/SECURITY.md` §8 | A CDN/edge-level layer (infra, not app code) | Eng/Ops | Tracked, roadmap |

---

## Verification performed this phase

- `pnpm lint` — 14/14 clean.
- `pnpm --filter @growth-agent/services typecheck` / `pnpm --filter
@growth-agent/web typecheck` — clean.
- `packages/services` unit/integration test suite — 1376 tests passing
  (up from 1356 at the start of this phase; +20 net, after also fixing a
  real, latent test-isolation bug this phase's own new tests exposed in
  `security/rate-limit.test.ts`).
- `node scripts/check-tenant-scope.mjs` — clean (after closing the 21-model
  allowlist gap this phase found).
- `node scripts/check-env.test.mjs` — 12/12 (added one new test for the
  Redis-AUTH-required rule).
- YAML syntax validation of `docker-compose.production.yml` (no live Docker
  available — same disclosed sandbox limitation as every phase since 27).

## Verification NOT performed this phase (disclosed, not fabricated)

- No live penetration test.
- No live restore drill (see `RISK-DR-1`).
- No live chaos/load test against production-representative traffic — this
  phase made no performance claims and ran no `autocannon`-style load test
  (that was Phase 28's scope, unchanged here).
- No live tabletop exercise of the new incident-response runbooks.
- No CodeQL/Semgrep/Trivy scan (unavailable in this sandbox).
- Container hardening changes were not deployed or verified against a
  running container (no Docker in this sandbox).
