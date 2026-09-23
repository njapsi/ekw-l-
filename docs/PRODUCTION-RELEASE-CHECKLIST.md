# PRODUCTION-RELEASE-CHECKLIST.md

The Phase 14 pre-launch checklist. Each item states what "done" actually
means and points to the evidence — a checkbox with no evidence is not
"done." Items marked **[LIVE INFRA REQUIRED]** cannot be completed from
this sandbox (no live Postgres/Redis beyond what a prior session
configured on staging, no real YouTube/TikTok/Stripe test credentials, no
load-testing environment, no SSH access to the live staging host from
this session) — they are real, necessary, un-skippable steps for whoever
runs the actual launch, not optional.

---

## Infrastructure

- [ ] Production environment variables set and validated:
      `node scripts/check-env.mjs --target web` and `--target worker` both
      report `✓ ready` against the **real** production `.env` (not the
      `.example` file). **[LIVE INFRA REQUIRED]**
- [ ] DNS verified: the production domain resolves to the correct host.
      **[LIVE INFRA REQUIRED]**
- [ ] TLS verified: `https://<domain>` serves a valid certificate;
      HTTP→HTTPS redirect works (Caddy auto-TLS, `deploy/Caddyfile`).
      **[LIVE INFRA REQUIRED]**
- [x] Database schema is current: `prisma validate` passes against the
      full schema (confirmed this session, dummy connection strings —
      schema-level validation, not a live-DB check).
- [ ] Database reachable from the app host with the production credential.
      **[LIVE INFRA REQUIRED]**
- [ ] Redis reachable, `rediss://` with a password (required by
      `scripts/check-env.mjs` in strict mode). **[LIVE INFRA REQUIRED]**
- [ ] Object storage: **not applicable** — this app has no object-storage
      -dependent feature (`docs/FORENSIC-AUDIT.md`); do not provision one
      speculatively.
- [ ] Workers verified: `worker` container's `/healthz` reports healthy
      and a `WorkerHeartbeat` row is fresh. **[LIVE INFRA REQUIRED]**

## Security

- [x] Secrets are not committed to git — verified this session via a
      pattern search for `sk_live_`/`sk_test_`/`AIza...`/`ghp_...` across
      the entire repository; every match was documentation/redaction
      -pattern code, not a real credential.
- [x] `AUTH_DEV_LOGIN`'s double-gate (`=== 'true'` AND `NODE_ENV !==
      'production'`) confirmed intact; both Dockerfiles set
      `NODE_ENV=production` unconditionally.
- [ ] Real OAuth credentials (Google, TikTok) configured for production,
      distinct from any staging/sandbox app registration.
      **[LIVE INFRA REQUIRED]**
- [ ] Real Stripe **live-mode** keys configured (only after a deliberate,
      explicit decision to go live with real payments — never test-mode
      keys in production). **[LIVE INFRA REQUIRED — and note: the user
      must never paste a live secret key in chat; set it directly in the
      platform's own secret store.]**
- [x] RBAC verified: capability-based permission catalog (50 permissions),
      `checkRoleChange`'s no-privilege-escalation invariant — code-reviewed
      this session and in every prior phase; unit-tested
      (`rbac/permissions.test.ts`, confirmed passing).
- [x] Tenant isolation: `scripts/check-tenant-scope.mjs` re-run this
      session — clean, every tenant model checked.
- [x] Rate limiting: Redis-backed, fail-open by default with two
      deliberately fail-closed credential-guessing surfaces (Phase 12) —
      code-reviewed, unit-tested.
- [x] Security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
      Referrer-Policy, Permissions-Policy — confirmed present in
      `next.config.mjs` and asserted by `e2e/api.spec.ts`.
- [x] Dependency audit: `node scripts/audit-allow.mjs` re-run this session
      — clean, 6 pre-existing allowlisted advisories (nodemailer,
      deepmerge-ts — both documented with mitigations), no new ones.

## Integrations

- [ ] YouTube: real OAuth connect → real channel/analytics data fetch,
      verified against a real account. **[LIVE INFRA REQUIRED]**
- [ ] TikTok: real OAuth connect → real profile/analytics data fetch,
      verified against a real (sandbox or audited) account.
      **[LIVE INFRA REQUIRED]**
- [ ] Search Console: real OAuth connect → real property/performance data
      fetch. **[LIVE INFRA REQUIRED]**
- [ ] Website crawler: a real crawl against a real, owned test site,
      confirming ownership verification, SSRF guard, and issue detection
      end-to-end. **[LIVE INFRA REQUIRED for a real target site; the SSRF
      guard's own defenses are unit/adversarially tested — 75 tests,
      confirmed passing this session.]**
- [ ] WordPress: real Application Password connect → real post/page
      fetch → a real draft creation. **[LIVE INFRA REQUIRED]**
- [ ] Stripe: a real test-mode checkout → webhook → entitlement update
      cycle. **[LIVE INFRA REQUIRED]**
- [ ] Email: a real magic-link/notification email actually delivered
      (Resend or SMTP, not `console` transport) in production.
      **[LIVE INFRA REQUIRED]**

## AI

- [x] Agent runtime, tool registry, policy engine: code-reviewed this
      session (`tool-executor.ts`, `wordpress-tools.ts` spot-checked —
      `assertCapabilityUsable`/`assertGovernanceAllows` confirmed wired at
      every tool definition, not just claimed in docs).
- [x] Permissions enforced server-side: confirmed via the same spot-check
      above and the existing `agents/ai-red-team.test.ts` (34 tests,
      re-confirmed passing this session as part of the full suite).
- [x] Prompt-injection fencing (`wrapUntrusted`) on every model-facing
      prompt: confirmed present across ~14 call sites per prior phases'
      audits, unchanged this phase.
- [x] Memory/research scoped to organization: `KnowledgeItem`/
      `MemoryCandidate`/`ResearchProject` all tenant-scoped and covered by
      the tenant-scope lint.
- [x] AI cost controls: `enforceAiBudget`, per-user throttle
      (`enforceAiUserLimit`), kill switches (`AI_DISABLED`/
      `AI_DISABLED_PROVIDERS`) — code-reviewed, unit-tested.
- [ ] A real, live AI Agent conversation against real connected data,
      verified end-to-end. **[LIVE INFRA REQUIRED — an AI provider key and
      at least one real connected integration.]**

## Operations

- [ ] Monitoring dashboards actually receiving data from the live
      deployment (`/api/metrics`, Prometheus). **[LIVE INFRA REQUIRED]**
- [ ] Alerts actually firing on a real triggered condition, not just
      configured (`deploy/alerts.yml`). **[LIVE INFRA REQUIRED]**
- [ ] Backups actually running on schedule and producing a real,
      restorable file. **[LIVE INFRA REQUIRED]**
- [ ] **A real restore drill, executed at least once** — `backup-restore.md`.
      This has never been done in this project's history. **[LIVE INFRA
      REQUIRED — treat as a hard prerequisite, not optional, per
      `docs/DISASTER-RECOVERY.md`'s own "a backup you have never restored
      is a hope, not a plan."]**
- [ ] A real rollback drill, executed at least once —
      `deployment-rollback.md`. **[LIVE INFRA REQUIRED]**
- [ ] Incident-response runbooks reviewed by whoever will actually be
      on call. **[HUMAN PROCESS — no on-call rotation exists yet, a
      disclosed gap.]**

## Sign-off

This checklist cannot be fully checked off from this sandbox. See
`docs/PHASE-14-FINAL-CERTIFICATION.md` for the honest, evidence-based
certification verdict this incomplete checklist supports.
