# PHASE-14-FINAL-CERTIFICATION.md

**Growth Agent — Phase 14: Final Production Certification, Launch
Readiness & Go-Live.** This is the formal certification report, following
the brief's own 26-section template. See
`docs/PHASE-14-PRODUCTION-CERTIFICATION.md` for the detailed audit-evidence
trail this report summarizes.

**A note on the scorecard's status column, stated up front:** the brief's
own template header says `PASS/FAIL`. Forcing every category into that
binary would produce a dishonest result in both directions — a category
that's never been tested against live infrastructure isn't a `FAIL` (it
may well work), and calling it `PASS` without evidence is exactly what
§116/the brief's own repeated instruction forbids. This report uses
**PASS** (verified this session or by a prior session's real, evidence
-based audit, no known issue), **CONDITIONAL** (real, working
implementation with a specific disclosed gap or an unresolved risk), and
**NOT TESTED** (requires live infrastructure this sandbox does not have —
never independently verified end-to-end in this project's history).

---

## 1. Executive summary

This phase re-audited the platform with fresh skepticism rather than
trusting thirteen prior phases' own documentation. The result: **no P0
blocker was found, and two real, previously-undetected bugs were found
and fixed** by treating an apparently "flaky" test as worth actually
root-causing rather than dismissing:

1. A test-infrastructure issue (`missions/crud.test.ts` intermittently
   timing out) turned out to be a genuine, if narrow, production
   -relevant behavior: `planMission`'s rate-limit check attempts a real
   Redis connection with a 3-second timeout before falling back open —
   harmless when Redis is actually reachable (production), but a real
   latency cliff worth knowing about, and a real source of untrustworthy
   CI signal in a Redis-less test run. Fixed by mocking the client in
   that test file, matching this codebase's own established pattern.
2. **A genuine financial-correctness bug** in the new credit ledger
   (`billing/credits.ts`, built this session's Phase 13): `currentBalance`
   read "the most recent transaction" by `createdAt DESC` alone. Two
   transactions written back-to-back — exactly what `grantCredits`
   immediately followed by `consumeCredits` does — can share the same
   millisecond timestamp (`TIMESTAMP(3)` has finite resolution), and a
   stable sort over a tie returns the *older* of the two rows, not the
   newer one — silently returning a stale balance. Reproduced as a real,
   intermittent test failure (not resource contention, ruled out by
   running the isolated test three consecutive times with 0 failures
   after the fix, vs. reproducing the bug without it). Fixed by adding
   `id` (a time-ordered, tie-free cuid) as a secondary sort key — the
   standard, correct pattern for exactly this problem.

Both fixes are verified: the full suite passed 3 consecutive times after
the credit-ledger fix (183 files / 1403 tests each run, 0 failures), and
lint/typecheck were re-confirmed clean afterward. The codebase's own
extensive prior audit trail (security audits at Phases 14/18/24/25/31, a
forensic audit at Phase 18, performance/accessibility passes at 28/29)
otherwise held up under fresh re-inspection everywhere it could be
checked without live infrastructure — a mock-data sweep found no
fabricated data, a secret-leak sweep found no committed credentials, and
targeted code reads confirmed AI tool authorization and container
hardening are genuinely implemented, not merely documented. **The
certification is CONDITIONAL, not PRODUCTION READY**, because a
substantial set of requirements this brief itself demands — real OAuth
connections, a real Stripe test-mode cycle, real load/soak testing, a
real backup-restore drill, a real deployment-rollback drill — have
**never been executed against this platform in its entire development
history**, in this session or any prior one. That is not a newly
-discovered failure; it is an honestly-disclosed, long-standing gap this
report is not going to paper over with a false PASS.

## 2. System inventory

See `docs/PHASE-14-PRODUCTION-CERTIFICATION.md` §6.

## 3. Infrastructure

Docker images, compose files, and Caddy TLS config are real and
code-reviewed; the production compose file has container hardening
(`cap_drop`/`no-new-privileges`) that the live staging compose file
**does not** (a real, disclosed gap — Phase 12's own deliberate choice not
to push an unverified change to running infrastructure). CI
(`.github/workflows/ci.yml`) genuinely builds both Docker images and boots
them against throwaway Postgres/Redis with a health-check assertion — a
real, working pipeline step, not a documented aspiration. **NOT TESTED**:
whether the actual production `.env` (as opposed to the validator script
itself) passes `check-env.mjs`; whether DNS/TLS are correctly configured
for a production domain (none is assigned yet, to this session's
knowledge).

## 4. Authentication

**PASS.** Magic-link, password (salted scrypt, rate-limited, no
enumeration oracle), Google OAuth, and TOTP MFA + recovery codes are all
real, unit-tested, code-reviewed. Session cookies are HttpOnly/Secure/
SameSite=Lax with server-side per-device revocation
(`UserSession`/`sessionVersion`). **CONDITIONAL**: MFA is not wired into
the sign-in flow itself (a deliberate Phase 12 scope decision, disclosed
in `docs/SECURITY_POSTURE.md`'s `RISK-AUTH-1`) — a compromised password
alone still signs in without a second factor even for a user who enabled
MFA for sensitive-action gating.

## 5. Authorization

**PASS.** A 50-permission capability-based catalog (`rbac/permissions.ts`)
with a proven no-privilege-escalation invariant (`checkRoleChange`,
unit-tested), re-checked at every Server Action and worker job
(`assertJobAuthorized`). **NOT TESTED**: a live, manual attempt at every
named unauthorized operation (§5 of the brief) against a real deployed
instance with real accounts in each role — this exists only as unit/
integration test coverage, not a live red-team pass this session.

## 6. Tenant isolation

**PASS**, with the strongest evidence of any category. Re-verified fresh
this session: `check-tenant-scope.mjs` clean against current code
(covering 21+2 models added across Phases 12-13 that had previously gone
unchecked — a real gap this project found and closed in its own history,
not hidden). A dedicated integration test suite
(`security/tenant-isolation.integration.test.ts`) has, per Phase 2's own
report, actually been run against a real, isolated database and passed.
**CONDITIONAL**: enforcement is application-layer (every query manually
scoped), not database-enforced Postgres RLS — a missed filter is caught
by the lint/tests, not made structurally impossible. This is the single
most-repeated disclosed risk across this entire project's history
(ADR-0035/0052/0061) and remains the platform's most significant
structural (not implementation) gap.

## 7. Database

**PASS** for schema correctness (`prisma validate` clean, 15 migrations,
all additive, zero destructive changes — confirmed by this project's own
stated convention and this session's own review of the two newest
migrations' SQL). **NOT TESTED**: a fresh-database → all-migrations →
app-startup run against a real Postgres instance (§7 of the brief) — this
sandbox has none; a real backup→restore→migration-verification→app
-startup cycle has **never been executed** in this project's history
(`docs/DISASTER-RECOVERY.md`'s own `RISK-DR-1`).

## 8. Integrations

**NOT TESTED**, uniformly, for all five (YouTube, TikTok, Search Console,
SEO crawler, WordPress). Every integration's *code* is real (typed API
clients, real OAuth flows, real capability matrices that honestly report
what's unsupported rather than fake it) and has been unit/integration
-tested against fixtures — but **no integration has ever been exercised
against a real external account or site**, in this session or any prior
one (every phase since the original integration work has disclosed this
identically). The one partial exception: the SEO crawler's SSRF defenses
have been adversarially tested with live reproduction techniques against
running code (Phase 24, re-confirmed passing this session — 75 tests) —
that specific subsystem has real evidence beyond unit tests, even without
a real target website.

## 9. AI

**PASS** for the safety architecture (spot-checked this session, not just
documented): tool-level authorization (`assertCapabilityUsable`/
`assertGovernanceAllows`) confirmed genuinely wired by reading
`wordpress-tools.ts` directly; universal prompt-injection fencing;
output-side secret scrubbing; forced-confirmation on external actions;
34 adversarial red-team tests re-confirmed passing. **NOT TESTED**: a
real, live AI Agent conversation against real connected integration data
end-to-end (requires a live AI provider key and a real connection, per
§10/§33 of the brief).

## 10. Missions

**PASS** for the safety architecture: a kill switch (`MISSIONS_HALT`,
Phase 12), weekly publish/content-generation throttles, RBAC re-check on
every tick, idempotent task claims (a real race fixed and tested this
session's Phase 12 work). **NOT TESTED**: a real, live, end-to-end mission
run (research → plan → task → approval → execution → measurement →
learning) against real connected platforms (§12/§36 of the brief).

## 11. Billing

**PASS** for the architecture, strengthened by two things genuinely
proven this session: a real concurrency race in usage enforcement (found
and fixed in Phase 13, re-confirmed this session with a passing proof
test — 10 concurrent requests vs. 5 capacity → exactly 5 succeed), and a
real financial-correctness bug in the credit ledger's balance-read logic
(found and fixed *this session* — see the executive summary — a
same-millisecond write tie could return a stale balance; now resolved
with a proper secondary sort key and verified stable across 3 consecutive
full-suite runs). Webhook idempotency (event-id ledger + upsert-keyed
handlers) is code-reviewed and unit-tested. **NOT TESTED**: any real
Stripe test-mode transaction — checkout, webhook delivery, payment
failure, refund — has never been run against this deployment (§13/§37 of
the brief). This is a genuine, material gap for a commercial launch.

## 12. Security

**PASS** for everything checkable without live infrastructure: fresh
lint/typecheck/test all clean; a mock-data sweep and a secret-leak sweep
both clean this session; the crawler's SSRF defenses are the most
adversarially-tested subsystem in the codebase; prompt-injection/AI
-red-team coverage exists and passes. **CONDITIONAL**: no dedicated DAST
scanner, no live penetration test, and no automated alerting on security
events has ever been run (`docs/SECURITY_POSTURE.md`'s own risk register
— `RISK-ALERT-1` and others — carried forward unchanged, not newly found
or newly resolved).

## 13. Performance

**CONDITIONAL**, carried forward from Phase 28's own honest report: real
`autocannon` load tests were run then against every endpoint reachable
without a database, finding and fixing two real N+1/redundant-work
issues; everything requiring a live database/Redis was architectural
capacity analysis, not measurement. **No new performance testing was
performed this session** (out of scope for a certification pass without
new infrastructure) — Phase 28's findings are cited, not re-verified.

## 14. Reliability

**PASS** for what's testable: idempotent job claims across missions/
research/automation (unit-tested, including a real race this session's
Phase 12/13 work found and fixed); BullMQ retry configuration with
exponential backoff (Phase 12, previously entirely absent — a real gap
closed). **NOT TESTED**: worker-restart-mid-job, Redis-restart, and
application-restart recovery (§15 of the brief) — no live infrastructure
to simulate these against.

## 15. Backup / recovery

**CONDITIONAL, leaning NOT READY on this specific item.** The backup/
restore scripts are real and code-reviewed
(`deploy/backup/pg-backup.sh`/`pg-restore.sh`), encrypted-at-rest since
Phase 31. **A real restore has never been executed in this project's
history** — `docs/DISASTER-RECOVERY.md` states this outright. Per that
same document's own words: "a backup you have never restored is a hope,
not a plan." This is the single item this report most wants to flag as
un-skippable before a real launch with real customer data.

## 16. Observability

**PASS** for what exists: structured pino logs with correlation ids and
secret redaction, a Prometheus-format `/api/metrics`, health checks
(including the Phase 12 addition of a real `/api/health/ready` with
genuine non-200 status codes), de-duplicated `ErrorEvent` capture across
server/client/edge. **NOT TESTED**: whether a real production deployment's
monitoring dashboard is actually receiving and displaying this data (no
live Prometheus/Grafana instance in this session to check).

## 17. Accessibility

**CONDITIONAL**, carried forward from Phase 29's own honest report: real
fixes were made (contrast, reduced-motion, heading semantics, live-region
announcements, cursor pagination), verified via research passes and
hand-computed contrast ratios, not a live screen-reader session. **No new
accessibility testing was performed this session.**

## 18. Testing

**PASS.** 1403 unit/integration tests passing, confirmed stable across
multiple consecutive full-suite runs this session (not just a single
green run); lint and typecheck both 14/14 clean; the tenant-scope and
dependency-audit CI gates both clean. The one apparent flakiness found
this session (`missions/crud.test.ts`) was root-caused, not just
dismissed — it was masking a real Redis-dependency issue and, while
investigating it, a real financial-correctness bug elsewhere (see §11).
Both are now fixed and verified.

## 19. Known limitations

See `docs/PHASE-14-PRODUCTION-CERTIFICATION.md` throughout, and every
prior phase's own disclosed limitations (compiled across `CLAUDE.md`'s
phase history) — not repeated here in full to avoid duplicating an
already-extensive record.

## 20. P0 issues

**None remain.** One issue found during this phase's re-audit arguably
touched the P0 category's spirit — "payment corruption" — narrowly: the
credit-ledger balance-read bug (§11) could, under a specific timing
condition, cause a subsequent operation to read a stale balance. It was
**found and fixed within this same session**, verified stable across 3
consecutive full-suite runs, so it is not carried forward as an open
blocker. No authentication bypass, no tenant data leak, no destructive AI
behavior, no secrets exposure, no database corruption, no unrecoverable
deployment path, and no other critical security vulnerability was found.

## 21. P1 issues

1. **No real Stripe test-mode transaction has ever been run.** A
   commercial launch without this is launching billing logic that has
   only ever been exercised against a fake gateway.
2. **No real restore drill has ever been executed.** Per
   `docs/DISASTER-RECOVERY.md`'s own words, this makes the recovery
   procedure a hope, not a plan.
3. **No real OAuth connection (YouTube/TikTok/Search Console/WordPress)
   has ever been completed against a live external account.** The
   product's core value proposition depends entirely on these working
   against real accounts, which has never been observed.

## 22. P2 issues

1. Container hardening (`cap_drop`/`no-new-privileges`) exists on the
   production compose template but not the live staging compose file.
2. No automated alerting fires on any `SecurityEvent` yet.
3. MFA is not wired into the sign-in flow itself, and `PlatformStaff`
   accounts are not required to enable it.
4. Postgres RLS remains unimplemented (structural, not a defect — the
   application-layer mitigation is real and tested).

Two items that would have appeared here were fixed during this phase
instead of merely documented: the `missions/crud.test.ts` flakiness (a
missing Redis mock) and the credit-ledger balance-read bug (§11) — see
the executive summary.

## 23. P3 issues

1. No enterprise-contract admin UI (service functions only).
2. No credit-purchase/checkout flow.
3. No MRR/ARR/churn admin reporting.
4. No per-user/team usage-breakdown UI.

## 24. Deployment readiness

**CONDITIONAL.** The Docker images, CI pipeline, and compose
configuration are real and have genuinely been built/booted in CI with a
health-check assertion. A real production deployment (DNS, TLS, real
secrets, real domain) has not been performed by this session — staging
is the closest live proof point, and this session has no access to
re-verify it directly.

## 25. Operational readiness

**CONDITIONAL.** Runbooks (`docs/runbooks/*.md`, 15 files, this phase),
a release checklist (`docs/PRODUCTION-RELEASE-CHECKLIST.md`, this phase),
and a go-live procedure (`docs/GO-LIVE.md`, this phase) all now exist as
real, usable documents. **No on-call rotation exists**; **no runbook has
ever been rehearsed as a live drill.**

## 26. Recommended launch sequence

1. Fix the two named P1 gaps that are actually fixable without new
   product work: run one real Stripe test-mode checkout cycle, and run
   one real restore drill against a throwaway Postgres instance. Both are
   pure verification, not development — they should happen before, not
   after, general availability.
2. Complete at least one real OAuth connection per integration against a
   real (or sandbox, where the provider offers one) account, following
   `docs/PRODUCTION-RELEASE-CHECKLIST.md`'s integration section.
3. Launch as a **closed / invite-only beta** first (matching Phase 18's
   own prior recommendation, still the right call) — this bounds the
   blast radius of anything the above verification steps would have
   caught, while gathering real production signal Phase 28's own
   performance work couldn't produce without live traffic.
4. Wire at least the highest-severity `SecurityEvent` types to a real
   alert channel before general availability.
5. Revisit Postgres RLS once a real, safe-to-experiment-on database
   environment exists — not before.

---

## Final certification status

# CONDITIONAL

Growth Agent may be deployed under the following explicitly documented
restrictions: (1) as a closed/invite-only beta, not general availability;
(2) with billing either not yet live, or launched only after a real
Stripe test-mode cycle has been run once; (3) with the operator aware
that no restore drill has ever been executed, and treating the first real
production incident requiring one as also the first real test of that
procedure; (4) with each integration's real-account behavior verified
manually before that integration is advertised as working, rather than
assumed from its (real, but unexercised-live) code.

No P0 blocker exists. The unresolved material risks are the three P1
items above — each is a verification gap, not a known defect. This
report does not claim PRODUCTION READY because that claim would require
evidence this sandbox cannot produce; it does not claim NOT READY because
no actual blocking defect was found. CONDITIONAL is the state the
evidence actually supports.
