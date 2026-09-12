# FINAL-SECURITY-REPORT.md — Phase 31: Final Production Security Review

**Verdict: GO.** No BLOCKER or CRITICAL application-level finding survived
risk-adjusted review. Two HIGH findings were found and are **fixed by this
phase** (below). Five MEDIUM findings remain as tracked follow-up work, none
of which blocks a production launch on their own. Full detail follows.

This is the sixth security-focused review of this codebase (after Phase 14
hardening, Phase 18 full + forensic audits, Phase 24 crawler/SSRF, Phase 25
AI red team, and the billing/AI production audits in Phases 22-23). It is
therefore a **consolidation + fresh-eyes pass + actually running the
requested tooling**, not a from-scratch audit: three parallel research
passes re-verified every prior audit's claims against the current code,
specifically hunting for regressions introduced by the five _non_-security
-focused phases since Phase 25 (26 data-accuracy, 27 e2e, 28 performance, 29
accessibility, 30 staging) — none were found. Two genuine, previously
-unnoticed HIGH-severity bugs were found instead, both fixed here.

---

## Tooling run this phase

| Tool / check                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dependency audit** (`pnpm audit`) | `--prod`: clean, 6 pre-existing allowlisted advisories (unchanged since Phase 19). Full scan (incl. devDependencies): 1 CRITICAL + 1 HIGH + 5 MODERATE, all in `vitest`/`vite`/`esbuild`/`@vitest/mocker` — test tooling, never shipped. See "Documented, not fixed" below.                                                                                                                                                                                                                                                                                                                                                                            |
| **Secret scan**                     | `detect-secrets` (installed transiently via pip, never added to the project) could not complete on this Windows machine — a reproducible multiprocessing/IPC crash in the tool itself (`BrokenPipeError`/`WinError 232`), unrelated to this codebase. Fell back to a targeted `git grep` for Stripe/AWS/Google/GitHub/Slack key shapes and PEM headers across every git-tracked file: **clean** — every hit was a labeled fixture inside a `*.test.ts` file testing the redaction logic itself. Also confirmed no `.pem`/`.key`/`.env`/service-account files are tracked, and manually reviewed Phase 30's `.env.staging.example` — placeholders only. |
| **SAST**                            | Semgrep has no native Windows support; both its npm wrapper and pip package failed to install in this sandbox (platform/network errors, not a codebase issue). Substituted with manual code-level review across auth, crypto, webhooks, CORS, CSP, rate-limiting, and tenant-scoping (three parallel research passes), plus this repo's own purpose-built static check, `scripts/check-tenant-scope.mjs` — **clean**.                                                                                                                                                                                                                                  |
| **DAST**                            | No OWASP ZAP or similar — needs Docker, unavailable (Docker Desktop cannot start; virtualization disabled in firmware, unchanged since Phase 27). Substituted with a live pass against the actual built-and-booted app: fetched real headers from `/`, `/api/health`, `/api/metrics`, a cross-origin probe, a malformed webhook POST, and a 404. **All confirmed adequate** (detail below). Re-ran the full DB-less Playwright suite fresh: **48 passed, 10 correctly self-skipped** (DB-gated cross-org/RBAC cases), 0 failed.                                                                                                                        |
| **Container scan**                  | Not possible — no image can be built without Docker. Same disclosed constraint as Phases 27-30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **API security tests**              | Covered by the DAST re-run above (`api.spec.ts`, `security.spec.ts`, `smoke.spec.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Crawler SSRF tests**              | Re-ran `ssrf.test.ts` + `pattern-match.test.ts` + `pinning-proxy.test.ts` + `robots.test.ts` + `url.test.ts` + `fetch.test.ts` + `link-graph.test.ts` — **75/75 passing**, matching Phase 24's documented fixes exactly.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **AI red-team tests**               | Re-ran `adversarial.test.ts` + `ai-red-team.test.ts` + `output-scrub.test.ts` + `grounding.test.ts` — **34/34 passing**, matching Phase 25's documented "13 new" `ai-red-team.test.ts` count exactly. Also re-ran `security/*.test.ts` (rate-limit, untrusted-content wrapping) — **11/11 passing**.                                                                                                                                                                                                                                                                                                                                                   |

---

## Live DAST-style spot checks (booted the production build, curled it directly)

- `curl -sD - http://localhost:3000/` → `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy: same-origin`, and
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  all present, exactly as `docs/SECURITY-AUDIT.md` and `next.config.mjs`
  document.
- A request with `Origin: https://evil.example.com` got **no**
  `Access-Control-Allow-Origin` echoed back — confirmed same-origin-only,
  matching the existing `api.spec.ts` assertion.
- `GET /api/metrics` with no auth → `403`.
- `POST /api/billing/webhook` with a deliberately bad `stripe-signature`
  header (Stripe configured with fake test-mode keys) → `400
{"error":"Invalid signature."}`, and **the new
  `webhook_signature_failures_total{provider="stripe"}` counter incremented
  live** at `/api/metrics` immediately after — verified end-to-end, not
  just type-checked (see MEDIUM-5 below).
- `GET /api/does-not-exist-xyz123` → clean generic 404 page, no stack trace,
  no path disclosure.
- No `X-Powered-By` header anywhere.

---

## Findings

### HIGH-1 — Backups could ship unencrypted, contradicting `docs/SECURITY.md`'s own claim

`deploy/backup/pg-backup.sh` only GPG-encrypted the dump `if [[ -n
"${BACKUP_GPG_RECIPIENT:-}" ]]` — optional. `docs/SECURITY.md` flatly stated
"Backups encrypted, access-controlled, restore tested quarterly" as an
accomplished control, and `scripts/check-env.mjs` had no `BACKUP_*`
validation at all — a production deploy could ship a fully unencrypted
`pg_dump` (every tenant's data, user PII, OAuth-token ciphertext) to object
storage with zero warning.

**Fixed.** `pg-backup.sh` now requires `BACKUP_GPG_RECIPIENT`
(`: "${BACKUP_GPG_RECIPIENT:?...}"`, matching the file's existing
required-variable convention) and refuses to run without it.
`.env.example`/`.env.staging.example` updated to say "required," and
`docs/SECURITY.md`'s claim now matches what the script actually enforces.

### HIGH-2 — `regenerateAssetAction` bypassed AI metering entirely (master instruction hard rule 11)

`apps/web/src/server/content-actions.ts`'s `regenerateAssetAction` →
`content.regenerateAssetJob` → `packages/services/src/content/assets.ts`'s
`regenerateAsset` makes a real `deps.model.generateObject(...)` call with
**zero** metering — no `usage.enforceAiUserLimit`, no
`usage.enforceUsage({meter: 'CONTENT_GENERATIONS'})`, no
`usage.recordUsage(...)` afterward. Its sibling `generateAssetsAction` in
the exact same file correctly calls all three. An authenticated
`content:manage` user could trigger unlimited, unbilled, unthrottled AI
calls by repeatedly hitting regenerate — a direct violation of the master
instruction's metering hard rule, not just a missing rate limit.

**Fixed.** `regenerateAssetAction` now calls the identical three-call
pattern its sibling already uses: `enforceAiUserLimit` →
`enforceUsage({meter: 'CONTENT_GENERATIONS', amount: 1})` → after a
successful regenerate, `recordUsage(...)` keyed on the freshly created
version's id for natural per-call idempotency.

### MEDIUM-1 — Backup pruning was broken for the MinIO (`mc`) path

The retention/prune step only ran `if command -v aws` — the script's own
documented MinIO fallback never pruned anything, so backups would
accumulate indefinitely on that path. The `aws` path's delete-key
reconstruction was also needlessly fragile parameter-expansion.

**Fixed.** The prune step now branches the same way the upload step
already does; the `aws` path's key derivation is simplified to
`${BACKUP_S3_BUCKET%/}/$key`, and a real `mc rm --recursive --force
--older-than "${RETENTION}d"` branch was added for MinIO.

### MEDIUM-2 — `REDIS_URL` didn't have to be TLS in production

`packages/services/src/config/env.ts` accepted plaintext `redis://` even
under strict production boot validation, unlike every other externally
-facing URL (`AUTH_URL`/`NEXT_PUBLIC_APP_URL`), which are forced to
`https://` in the same strict mode.

**Fixed.** Both the runtime Zod validator (`config/env.ts`) and the
pre-deploy gate (`scripts/check-env.mjs`) now require `rediss://`
specifically when the strict/production path is active, using the same
`--allow-insecure`-style override already established for the HTTPS
checks. Confirmed the existing `.env.staging.example` (Phase 30) and
`check-env.test.mjs`'s baseline config already use `rediss://` — no
fallout.

### MEDIUM-3 — No disaster-recovery section anywhere; the single-VPS SPOF was never explicitly accepted as a risk

No RTO/RPO targets, no "VPS dies" / "Postgres provider outage" runbook
existed in any doc — `docs/SECURITY.md`'s incident-response section covers
_security_ incidents, not infrastructure loss. The single-host architecture
(`docker-compose.production.yml`, by deliberate design) was never named as
an accepted risk anywhere a reviewer would look.

**Fixed.** Added `docs/DEPLOYMENT.md` §18 "Disaster recovery": an explicit
accepted-risk statement for the single-host SPOF, an honest RTO/RPO
estimate derived from the actual backup cadence already in place (not
invented numbers), and a short runbook for the two realistic scenarios
(VPS loss, managed-Postgres-provider outage). Also names explicitly, for
the first time in this repo, that `pg-restore.sh` has never been
demonstrably executed end-to-end — "documented quarterly" is aspirational,
not yet true.

### MEDIUM-4 — No least-privilege guidance for the backups bucket specifically, and `docs/DEPLOYMENT.md` §3 described a nonexistent app feature

Two related documentation-accuracy problems found under the "file storage"
review area: (a) the app's own object-storage bucket had explicit IAM
guidance, but the separate backups bucket had none; (b) §3 as written
instructed a deployer to provision a bucket, IAM keys, and presigned-URL
config for **object storage as an application feature** — but no code
anywhere reads `S3_*` (confirmed by grep; already correctly documented as
"NOT IMPLEMENTED" in `.env.example` and `docs/FORENSIC-AUDIT.md`). Left
as written, a deployer following this runbook literally would provision
and pay for infrastructure the app cannot use.

**Fixed.** `docs/DEPLOYMENT.md` §3 rewritten to state plainly that object
storage is a planned, not implemented, application feature, and to give
the real, load-bearing guidance for the one genuinely real
object-storage use — the backups bucket — including a write-only key for
the backup host and a separate read-only key for whoever performs
restores, never a shared credential.

### MEDIUM-5 — No alerting for webhook signature failures

`deploy/alerts.yml` covered availability/error-rate/job-failure/AI-cost
conditions but nothing fired on a Stripe webhook signature verification
failure — a cheap, well-defined, security-relevant event that was
completely unobservable.

**Fixed.** Added `recordWebhookSignatureFailure` to the metrics registry
(`packages/services/src/observability/metrics.ts`), wired it into the
webhook route's existing bad-signature branch
(`apps/web/app/api/billing/webhook/route.ts`), and added one Prometheus
alert rule (`deploy/alerts.yml`, new `growth-agent.security` group) for a
sustained rate > 0. **Verified live**, not just type-checked (see the DAST
section above).

---

## Documented, not fixed (rationale)

- **The devDependency-only vitest/vite/esbuild CVEs** (1 critical, 1 high, 5
  moderate, found by the full — not `--prod` — dependency audit): fixing
  all of them needs a major-version bump of the vitest/vite toolchain (no
  patched 2.x vitest release exists — confirmed against the npm registry;
  the fix requires 3.x or 4.x), used across 4+ `vitest.config.ts` files
  in this monorepo. A toolchain major-version bump is a testing-intensive
  change out of proportion for a review phase — the same reasoning this
  codebase already applied to the nodemailer/deepmerge-ts advisories.
  **Zero production exposure today** (confirmed via `pnpm audit --prod`),
  and the CRITICAL one specifically requires `vitest --ui`, which nothing
  in this repo's scripts or CI invokes (confirmed by grep). Recommended as
  a dedicated future phase.
- **A general failed-authentication-attempt alert**: this app's auth model
  (magic-link + OAuth, no passwords) has no single, unambiguous definition
  of "a failed login attempt" (a bounced magic-link email? an OAuth
  `access_denied`? a revoked-session replay?) without a product decision
  first. Shipping a metric for an ill-defined event would be worse than
  not having one — deferred pending that decision, unlike the webhook case
  above, which had one clear, already-existing code branch to hang a
  metric on.
- **Nonce-based CSP**: already a tracked, named follow-up (`CLAUDE.md`'s
  "Still outstanding" section, unchanged since Phase 14) — re-confirmed
  live this phase (the served CSP is static, with `'unsafe-inline'` on
  `script-src`/`style-src`) — not a new finding, no new action this phase.
- **A full container scan / OWASP ZAP DAST**: needs Docker, unavailable in
  this environment — same disclosed constraint as every phase since 27.
- **Enforcing backup-bucket IAM from application code**: infrastructure
  -level access control can only be documented (Finding MEDIUM-4), not
  enforced by code running inside the app.
- **A demonstrated backup-restore drill**: `pg-restore.sh` is real,
  reasonable tooling, but actually running it needs a live Postgres and
  object-storage credentials this environment doesn't have — named as an
  open action item in the new DR section instead of attempted here.

---

## Review by area (all 22 requested)

| Area             | Status                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication   | Confirmed unchanged/adequate since Phase 25 — `sessionVersion` revocation, JWT config verified against current code.                                                                                                                                                                                                                                       |
| Authorization    | Confirmed adequate — every mutating Server Action spot-checked calls `requirePermission`; the two exceptions found (`youtube-actions.ts`, `tiktok-actions.ts`) are correctly scoped to caller-owned/read-only operations, not gaps.                                                                                                                        |
| RBAC             | Confirmed adequate — `packages/services/src/rbac/authorize.ts` unchanged; policy table verified against current call sites.                                                                                                                                                                                                                                |
| Tenant isolation | Confirmed adequate — `scripts/check-tenant-scope.mjs` passes; traced Phase 28's parallelized orchestrator/content-generation loops line-by-line for shared-mutable-state leaks — none found (each closure reads only per-invocation locals); the new `listCrawlIssues` total-count query reuses the exact same tenant-scoped `where` as its sibling query. |
| OAuth            | Confirmed unchanged since Phase 25 — signed state, session-binding (H-1), rate limiting (H-2) all present and functioning.                                                                                                                                                                                                                                 |
| Tokens           | Confirmed adequate — AES-256-GCM envelope with `keyId` rotation unchanged.                                                                                                                                                                                                                                                                                 |
| Secrets          | Confirmed adequate — pino redaction covers Stripe/JWT/connection-string patterns; the new Phase 30 `.env.staging.example` contains only placeholders (independently re-verified this phase).                                                                                                                                                               |
| Database         | Confirmed adequate — every tenant model carries `organizationId` with sensible cascade behavior; Postgres RLS still accurately documented as "not implemented," not silently claimed done.                                                                                                                                                                 |
| Redis            | **MEDIUM-2 found and fixed** (TLS not enforced in production) — otherwise adequate; fail-open rate-limiting confirmed intentional.                                                                                                                                                                                                                         |
| Crawler          | Confirmed adequate — 75/75 SSRF/pattern-match/pinning-proxy/robots/url/fetch/link-graph tests passing, matching Phase 24.                                                                                                                                                                                                                                  |
| AI               | Confirmed adequate — 34/34 red-team/adversarial/grounding/output-scrub tests passing, matching Phase 25. **HIGH-2 found and fixed** (a metering gap, not an AI-safety gap).                                                                                                                                                                                |
| Webhooks         | **MEDIUM-5 found and fixed** (no failure alerting) — signature verification itself confirmed correctly ordered before any DB write, idempotency ledger confirmed correct.                                                                                                                                                                                  |
| Billing          | Confirmed adequate — every billing Server Action gated `billing:manage` (OWNER); browser only ever receives a Stripe-hosted URL.                                                                                                                                                                                                                           |
| Admin            | Confirmed adequate — every `(admin)` route gated by the shared layout's `requirePlatformStaff()`; Phase 29's accessibility edit to `data-table.tsx` touched only a `scope="col"` attribute, no auth logic.                                                                                                                                                 |
| File storage     | **MEDIUM-4 found and fixed** (documentation described a nonexistent feature) — confirmed (again) no code reads `S3_*`.                                                                                                                                                                                                                                     |
| API              | Confirmed adequate — full DAST-style live pass + fresh e2e re-run, see above.                                                                                                                                                                                                                                                                              |
| Rate limiting    | Confirmed adequate — `content:manage`'s AI-calling actions already covered via `enforceAiUserLimit` (a different name for the same throttle concept as `checkRateLimit`); the one action missing it entirely was HIGH-2, now fixed.                                                                                                                        |
| CORS             | Confirmed adequate — no `Access-Control-Allow-Origin` anywhere, verified live.                                                                                                                                                                                                                                                                             |
| CSP              | Confirmed adequate but static (not nonce-based) — already a tracked, unchanged follow-up, not a new finding.                                                                                                                                                                                                                                               |
| Security headers | Confirmed adequate — HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy/Permissions-Policy/COOP all present, verified live.                                                                                                                                                                                                                       |
| Logging          | Confirmed adequate — redaction covers Stripe key patterns, JWTs, connection strings.                                                                                                                                                                                                                                                                       |
| Monitoring       | **MEDIUM-5 found and fixed** (webhook-signature-failure alerting gap); everything else (availability, error rate, job failures, AI cost burn) already covered.                                                                                                                                                                                             |

---

## Verification run this phase

- `pnpm format:check && pnpm lint && pnpm typecheck` — 14/14 clean.
- `pnpm --filter @growth-agent/services test` — **681/681 passing**,
  unchanged count (the fixes are a shell script, two validator tightenings,
  one Server Action gaining three already-tested library calls, and one
  new one-line metrics wrapper — no new test files, consistent with this
  codebase's existing convention of not unit-testing trivial one-line
  metric wrappers).
- Crawler/SSRF (75), AI red-team (34), and `security` (11) suites re-run a
  second time after all fixes landed — still green.
- `pnpm test:scripts`, `node scripts/check-tenant-scope.mjs`,
  `node scripts/audit-allow.mjs` — all clean.
- `pnpm --filter @growth-agent/web build` — successful production build.
- `bash -n deploy/backup/pg-backup.sh` — shell syntax valid.
- Live verification: booted the built app twice — once for the header/CORS/
  404 DAST pass, once with fake Stripe test-mode keys specifically to
  exercise the new webhook-signature-failure metric end-to-end (confirmed
  it appears at `/api/metrics` immediately after a rejected request).

## Residual risks

- The two HIGH and five MEDIUM findings above are fixed or documented;
  none is a BLOCKER or CRITICAL, so this report's recommendation is **GO**
  for production, conditional on nothing more than what's already true
  after this phase's fixes land.
- No SAST tool, no container scan, and no full DAST tool actually ran in
  this environment — the substitutes used (manual review, live spot
  -checks, existing e2e) are reasonable but not equivalent to the real
  tools; a CI environment with Docker/Linux available should run Semgrep,
  Trivy, and a proper ZAP baseline scan at least once before General
  Availability.
- The backup-restore procedure remains unverified by an actual drill — the
  script exists and looks correct, but "looks correct" and "has been
  proven to work" are different claims, named explicitly in the new DR
  section.
- The dev-tooling CVEs (vitest/vite) will keep showing up in every future
  `pnpm audit` full-scan until a dedicated toolchain-upgrade phase happens;
  they're correctly excluded from the `--prod` gate so they won't block
  deploys, but they're also not silently going away.
