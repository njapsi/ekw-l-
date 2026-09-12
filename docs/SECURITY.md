# SECURITY.md

Security is a first-class requirement, not a phase. This document is the
checklist every phase is reviewed against and the reference for how each control
is implemented.

> A full audit was performed in the operator's "Phase 14" — findings, fixes and
> an area-by-area verdict are in **`docs/SECURITY-AUDIT.md`** (0 Critical, 2
> High, 3 Medium; all Critical/High fixed). ADR-0029 records the hardening
> decisions.

---

## 1. Threat model (summary)

| Asset                                 | Threats                                               | Primary controls                                                                             |
| ------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Customer analytics + crawl data       | cross-tenant access, exfiltration                     | tenant isolation, RLS, isolation tests, least-privilege                                      |
| OAuth tokens for connected properties | theft → takeover of a user's YouTube/TikTok/GSC       | encryption at rest, least scope, rotation, revoke-on-disconnect, no token in logs/responses  |
| The crawler's egress                  | SSRF into internal network / cloud metadata           | allowlist + ownership verification, IP-range blocking, isolated egress, scheme/redirect caps |
| AI agents                             | over-broad tools, injected instructions, runaway cost | per-agent allowlists, untrusted-content quarantine, approval gates, budgets, kill switch     |
| Billing                               | tampered webhooks, replay, privilege abuse            | signature verification, event-id dedupe, OWNER-only billing actions                          |
| Auth                                  | session theft, brute force, magic-link abuse          | HttpOnly/Secure/SameSite cookies, rate limits, short-lived single-use tokens                 |
| Admin console                         | insider misuse                                        | separate `PlatformStaff` authz, full audit, cross-tenant reads flagged                       |
| Secrets                               | leakage to browser, logs, repo                        | env-only, secret store, `NEXT_PUBLIC_` allowlist, log scrubbing, pre-commit + CI secret scan |

---

## 2. Authentication

- **Auth.js (NextAuth v5)**, Prisma adapter for users/accounts/verification
  tokens, **JWT session strategy** (ADR-0011 — required so edge middleware can
  verify the session without a database).
- Sign-in: email magic-link (single-use token, hashed at rest, 15-min TTL,
  rate-limited `5/hour/email`) and Google OAuth (`state` + PKCE, minimal
  scopes). A **dev-only** credentials provider for seeded users is gated behind
  `AUTH_DEV_LOGIN=true` **and** `NODE_ENV !== 'production'`.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, 8-hour max age. The JWT
  payload carries only ids, org roles, and the `isPlatformStaff` flag — **no
  secrets** (the payload is readable, only the signature is not).
- **Revocation:** the JWT carries `sv` = `User.sessionVersion`. The `/app`
  server layout re-reads `sessionVersion` and `deletedAt` from the database on
  every request and forces re-login on a mismatch. Bumping `sessionVersion`
  invalidates all of a user's tokens within the 8-hour window.
- No passwords in MVP → no password storage risk. If added later: Argon2id,
  breach-list check, per-user rate limiting.
- `trustHost` is enabled (self-hosted behind a reverse proxy that sets a
  correct `Host` / `X-Forwarded-Host`).
- Enterprise: SSO (OIDC/SAML via WorkOS) + SCIM, enforced per-org.

## 3. Authorization & tenancy

- Central `authorize(actor, org, action)` over a single policy table
  (`API.md` §3). No ad-hoc role checks in handlers.
- Active organization derived from session + membership, **never** from request
  body/params without validation.
- Cross-tenant resource access returns `404`, not `403` (no enumeration).
- **Row-Level Security** in Postgres (`app.current_org` GUC per transaction,
  policies on every tenant table) is the **intended** defense-in-depth backstop
  but is **not yet implemented** — the current `withOrgScope` helper is unused
  and a safe `FORCE RLS` retrofit needs a `withTenant()` wrapper across ~320
  call sites plus a second non-owner DB role (tracked HIGH, ADR-0035 §5). Until
  then tenant isolation is **app-layer only**: every service query filters by
  `organizationId`, `scripts/check-tenant-scope.mjs` fails CI on an unscoped
  list/bulk/aggregate query, and the isolation integration suite is the enforced
  guarantee.
- Isolation tests in CI: for every module's public API, user of org A gets
  `404`/deny on org B resources (read, write, list, export).
- Dependency advisories: `scripts/audit-allow.mjs` gates CI on any new
  moderate+/high `pnpm audit` finding; accepted ones are listed with a reason in
  `.audit-allowlist.json`.
- Admin authz is a separate path (`PlatformStaff` + `StaffLevel`); its
  cross-tenant reads are explicit and audit-logged.

## 4. Secrets & configuration

- All secrets via environment variables sourced from the platform secret store.
  Validated at boot (Zod); boot fails on missing/invalid.
- **Never exposed to the browser:** OAuth client secrets, API keys, DB
  credentials, `ENCRYPTION_KEY`, `AUTH_SECRET`, Stripe secret/webhook keys,
  service-role DB key, provider keys. Only `NEXT_PUBLIC_*` reaches the client;
  a CI check greps the client bundle for known secret patterns.
- Logs are scrubbed: a pino serializer redacts `authorization`, `cookie`,
  `set-cookie`, `token`, `secret`, `password`, `access_token`, `refresh_token`.
- Secret scanning: pre-commit (gitleaks) + CI + GitHub secret scanning.
- Key rotation runbook for `ENCRYPTION_KEY` (envelope encryption with a key id
  column so re-encryption is incremental).

## 5. OAuth & connected-account tokens

- Request the **minimum** scopes per feature; incremental auth for more
  (revenue analytics on YouTube, `video.publish` on TikTok are opt-in).
- Access/refresh tokens encrypted with **AES-256-GCM** (`ENCRYPTION_KEY`),
  stored as the `OAuthConnection.*Cipher` + `*Iv` + `*AuthTag` + `keyId`
  columns (`crypto/tokens.ts`). Never `SELECT`ed into an API response or a log
  line.
- **OAuth `state`** is HMAC-signed (`AUTH_SECRET`, 10-min TTL) and carries the
  acting org + user; the callback trusts the verified state, never a query
  param. **TikTok** additionally uses **PKCE (S256)** with the `code_verifier`
  held in a signed, HttpOnly, path-scoped, 10-minute cookie (ADR-0015).
- Refresh handled server-side by `withFreshAccessToken` (proactive within 60 s
  of expiry, plus one forced refresh + retry on a live 401), dispatched per
  provider through a small OAuth registry (ADR-0016). On unrecoverable failure →
  `status = ERROR` + a reconnect prompt; never a silent failure.
- Disconnect: revoke upstream, set `REVOKED`, scrub the ciphertext, keep an
  audit entry. Org deletion cascades all connections.
- **Authorized publishing** (TikTok Content Posting API): every post is a
  `TikTokPublish` row that starts `AWAITING_APPROVAL`; submission requires an
  explicit `approve === true` and is refused otherwise (`automation_disabled`).
  A content-hash duplicate guard blocks re-publishing an equivalent post. Every
  transition is audit-logged. Nothing is ever published without a user click
  (master instruction, section K).
- Comply with Google API Services User Data Policy (Limited Use) and YouTube API
  Services / TikTok Developer terms; data used only to provide the feature the
  user asked for, not sold, not used for ads.

## 6. Web application hardening

- **Security headers** (via `next.config` + middleware): `Content-Security-
Policy` (nonce-based, no `unsafe-inline` for scripts), `Strict-Transport-
Security` (preload), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Permissions-Policy` minimal,
  `Cross-Origin-Opener-Policy: same-origin`.
- **Content-Security-Policy** (implemented in `apps/web/next.config.mjs`,
  ADR-0029): `default-src 'self'` with `script-src 'self' 'unsafe-inline'` (App
  Router inline hydration; `'unsafe-eval'` dev-only), `style-src 'self'
'unsafe-inline'`, `img-src 'self' data: blob: https:`, `connect-src 'self'`,
  `frame-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `object-src 'none'`, `upgrade-insecure-requests` (prod).
  A strict nonce-based `script-src` is a tracked follow-up.
- **CSRF:** Server Actions carry framework CSRF protection; state-changing REST
  handlers require same-origin + a double-submit token for any cookie-auth
  non-Action call. OAuth flows use a signed `state` **and** are bound to the
  session that started the flow (the callback rejects a `state` whose `userId`
  is not the signed-in user — ADR-0029, SECURITY-AUDIT.md H-1).
- **XSS:** React auto-escaping; no `dangerouslySetInnerHTML` with untrusted
  input; sanitize any rendered HTML from crawl data with a strict allowlist;
  CSP as backstop.
- **SQL injection:** Prisma parameterized queries only; `queryRaw` requires a
  reviewed tagged template and is banned by lint outside `packages/db`.
- **Clickjacking:** framing denied.
- **Open redirect:** post-login/redirect targets validated against an allowlist
  of internal paths.
- **File handling:** uploads via presigned S3 PUT with content-type + size
  limits; files served via short-lived presigned GET; never executed; virus
  scan hook for user uploads (post-MVP).

## 7. SSRF & the crawler

The crawler is the highest-risk egress. `packages/services/src/seo/ssrf.ts` is
the single authority (ADR-0019); `seo/fetch.ts` is the only client that opens
sockets for a crawl. Controls (full detail in `SEO-ENGINE.md`):

- Only crawl a `Website` whose `verified = true` (DNS TXT record or an HTML
  token file at `/.well-known/growth-agent-verify.txt`) beyond a shallow public
  sample (≤ 10 pages, depth ≤ 1, no rendering).
- Resolve DNS ourselves via an injectable resolver and validate **every**
  returned address against an IPv4+IPv6 blocked-range table: loopback (`127/8`,
  `::1`), `0.0.0.0/8`, private (`10/8`, `172.16/12`, `192.168/16`), CGNAT
  (`100.64/10`), link-local (`169.254/16`, `fe80::/10`) incl. cloud metadata
  `169.254.169.254`, ULA (`fc00::/7`), multicast, benchmark/TEST-NET ranges, and
  an IPv4 address embedded in an IPv6 literal (mapped `::ffff:0:0/96`,
  compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) — decoded from the
  address's **numeric groups**, not a string regex on a dotted quad, so it
  catches the canonical hex-group form a URL parser produces
  (`docs/CRAWLER-SECURITY-AUDIT.md` BLOCKER-1 — a real, confirmed bypass fixed
  in Phase 24).
- A **mixed** DNS answer (some public, some private) is refused outright — a
  DNS-rebinding tell.
- The socket connects **pinned to a validated IP**; SNI + `Host` stay the real
  hostname (defeats the resolve→connect TOCTOU). Every redirect hop is
  re-validated the same way.
- Schemes: `http`/`https` only. Ports: 80/443 only. Max redirects: 5.
  `Authorization`/`Cookie` are stripped on a cross-origin redirect. Response
  byte cap **and** decompressed-size cap (guards decompression bombs). Only
  textual content types are parsed. Sitemap XML is parsed with entity expansion
  disabled and a byte cap.
- robots.txt Allow/Disallow matching and crawl include/exclude path globs use a
  **linear, non-backtracking** wildcard matcher (`seo/pattern-match.ts`) — the
  robots.txt content is entirely attacker-controlled (it's the crawled site's
  own file), and a naive `* -> .*` regex translation was a confirmed ReDoS: a
  ~40-character pattern hung the process indefinitely, and the worker runs
  several crawl jobs concurrently in one process, so one poisoned robots.txt
  could freeze every other org's in-flight crawl (CRITICAL-2, fixed Phase 24).
- Global + per-org kill switch (`CRAWLER_HALT`, `CRAWLER_HALT_ORG_IDS`) checked
  at plan and at each page; a robots.txt full-disallow records the crawl as
  `BLOCKED`, never evaded.
- Egress ideally from a dedicated worker pool with a network policy / egress
  proxy that can only reach the public internet (infra task, deferred).
- The headless renderer (`apps/worker`) applies the same `assertSafeUrl`
  allowlist to every subresource request via a Playwright route interceptor,
  **and** every render's browser context is routed through a local
  `PinningProxy` (`seo/pinning-proxy.ts`) that pins the actual socket to the
  validated address — the route interceptor alone cannot stop DNS rebinding,
  because Chromium's own DNS resolution happens after that check and was never
  pinned to what we validated (CRITICAL-3, fixed Phase 24). See
  `docs/CRAWLER-SECURITY-AUDIT.md`.
- The fetch layer used by `search_web_public` (AI tools) will share this module.

## 8. Rate limiting & abuse protection

- Layered limits (`API.md` §7): edge IP → per-identity (Redis token bucket) →
  per-org usage limits.
- **Implemented so far** (`packages/services/src/security/rate-limit.ts`,
  ADR-0029): a fixed-window Redis counter that **fails open** if Redis is down,
  applied to magic-link send (5/hour/email, via the `signIn` callback), OAuth
  connect (15/10min/user) + callback (20/10min/IP), agent run (20/min/org+user),
  crawl start (10/10min/org) and `/api/health` (240/min/IP + a 4 s report
  cache). The full edge/IP layer and an aggregate magic-link volume cap remain
  roadmap "Phase 3".
- Sensitive buckets: login, magic-link send, invitation send, OAuth callback,
  crawl start, agent run start, report export, password-reset (if added).
- Abuse monitoring (Admin): repeated auth failures, crawl attempts on
  unverified/blocked hosts, token-refresh storms, sudden usage spikes,
  many orgs from one signup fingerprint → alerts + optional auto-suspend.

## 9. Background jobs

- Workers run with least privilege; job payloads carry **ids, not secrets**
  (secrets fetched at execution from the store).
- Processors are idempotent; poison messages → DLQ + alert, never infinite
  retry.
- Jobs are tenant-scoped; a job cannot widen scope via its payload.
- The crawl/render pool is network-isolated (§7).

### 9a. Automation engine (Phase 12, ADR-0027)

- **An automation never exceeds its owner's permissions.** Each `AutomationRule`
  has an `ownerId`; before every execution the runner resolves that owner's
  _current_ membership + role and runs it through the shared `authorize()`
  choke point against the task type's single `requiredAction`. If the owner
  lost the role or left the org, the run is `SKIPPED` and the rule is `PAUSED` —
  never executed with stale authority. The same check runs when a rule is
  created or edited.
- **No automation task type performs an external publish.** All seven types are
  read / analysis / report actions; `TASK_TYPE_META` marks
  `externalPublish: false` and `assertNoExternalPublish()` is a unit-tested
  invariant. Publishing stays behind its own explicit approval flow.
- **Idempotent execution.** `AutomationRun` has
  `@@unique([automationRuleId, scheduledFor])` (tick snapped to the rule's
  `nextRunAt`), so a double sweep, a worker restart, or a duplicated job never
  runs the same tick twice.
- **Bounded failure.** Retries use exponential backoff (60s·2^(n-1), cap 1h) up
  to `maxRetries`; 5 consecutive terminal failures → `FAILING` (surfaced), 10 →
  `DISABLED` (the sweep stops touching it) so a broken automation cannot hammer
  a downstream API or the model provider.
- Every create / update / pause / resume / delete and every run outcome
  (`succeeded` / `failed` / `skipped` / `retry_scheduled` / `cancelled`) is
  audit-logged; `SYSTEM`-actor for scheduled runs.

## 10. Webhooks

- Verify signature **before** parsing (Stripe `Stripe-Signature` + endpoint
  secret; Google OIDC audience; TikTok signature).
- Dedupe on provider event id (unique column); replay-safe.
- Respond `2xx` fast after enqueueing internal processing; a reconcile job
  covers missed/failed events.
- Outbound webhooks (post-MVP): per-org signing secret, HMAC-SHA256 signature,
  delivery log, manual replay.
- **Billing webhooks (Phase 10, ADR-0025):** `/api/billing/webhook` is public
  (Stripe is the caller); the request is authenticated only by its signature,
  verified with `node:crypto` HMAC-SHA256 over `"<t>.<raw body>"` plus a ±300s
  timestamp tolerance (replay protection) — implemented directly, no SDK. Raw
  body read via `req.text()` so the signed payload is byte-exact. Idempotency is
  twofold: a `BillingEvent` ledger row whose id **is** the Stripe event id
  (a redelivery is skipped before any work), and every handler is an upsert
  keyed on a Stripe id so a torn run converges. Bad signature → `400` (no
  retry); handler error → `500` and the ledger row stays `FAILED` for retry on
  redelivery. When Stripe is unconfigured the endpoint acknowledges `200`
  without processing.

## 10a. Billing authorization & metering

- Every billing mutation (checkout, portal, plan change, cancel, resume) is a
  Server Action guarded by `billing:manage` (**OWNER only**). **The browser is
  never trusted for a billing or a usage-limit decision** — it only ever
  receives a Stripe-hosted URL to redirect to.
- **No card data touches the app.** Stripe holds all PCI scope; we store only
  `stripeCustomerId` / `stripeSubscriptionId` / `stripePriceId` and a read-only,
  amounts-only `Invoice` mirror.
- Usage limits are enforced **server-side** by `usage.enforceUsage` before the
  metered work runs (429 `usage_limit_exceeded` when over). `usage.recordUsage`
  is idempotent on an `idempotencyKey`, so a retried request or re-run job never
  inflates a counter. Limits come from the plan catalog → PLAN `Entitlement`
  rows; support may add an audited `OVERRIDE` / `PROMO` row that wins at read
  time.

## 10b. Report share links (Phase 11, ADR-0026)

- A shared report URL (`/r/<token>` and its `/export` endpoint) is **public and
  unauthenticated** — the token (32 random bytes, base64url, `@unique`) is the
  only credential. It is gated by `shareExpiresAt` / `shareRevokedAt`; an
  unknown, malformed, expired, revoked or non-`READY` token returns a plain
  `404`, never data.
- The public routes serve `redactSnapshotForPublic(snapshot)` **only** — never
  the stored snapshot. Redaction replaces the subject label + org name with
  generic text, scrubs every free-text field of emails, URLs, `@handles` and
  long ids, and hides raw monetary amounts (aggregate counts, scores and
  relative deltas remain). The redaction is idempotent and unit-tested.
- Public pages/exports set `noindex` (`robots` meta + `x-robots-tag`).
- Creating or revoking a link requires `report:share` (**ADMIN+**), because it
  exposes data outside the org; generating/deleting a report requires
  `report:generate` (MEMBER+); viewing + the authenticated export endpoint
  requires `report:read` (VIEWER+, org-scoped). Every generate / delete /
  share-create / share-revoke is audit-logged.
- Reports are **immutable snapshots**: once `READY` the stored snapshot is never
  changed, so a shared link (or a downloaded PDF/CSV) cannot be made to show
  different data after the fact.

## 11. AI-specific security

- Per-agent tool allowlists; per-tool required scopes; `read_*` tools org-scoped
  by the registry (agent can't widen scope by argument).
- Untrusted content (crawled HTML, metadata, API payloads, user text) is
  quarantined as data — never instructions; cannot alter authorization, scope,
  budgets, or approval state. Structurally: the agents feed models only
  deterministic, structured derivatives (issue codes, counts, scores), and
  every tool registry is read-only + org-scoped with **no write / command /
  publish tool** — a successful injection can make a model say something wrong,
  never do anything. **Every** model prompt that carries external or
  user-supplied text now fences it with `security.wrapUntrusted(label, text)`
  and its system prompt carries `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` — Phase 22
  extended this from the content/SEO agents to the YouTube analyst
  (`YOUTUBE_VIDEO_METADATA`), TikTok analyst (`TIKTOK_VIDEO_METADATA`),
  monetization analyst (`MONETIZATION_SIGNALS`), content generator
  (`CONTENT_ANALYSIS`), and the Growth Agent planner / orchestrator / memory
  extractor (`USER_MESSAGE`, `CHAT_HISTORY`, `CAPABILITY_EVIDENCE`). The
  grounding check runs after the model as a second line. Adversarial coverage:
  `packages/services/src/agents/adversarial.test.ts`. ADR-0029, ADR-0037,
  SECURITY-AUDIT.md M-2.
- **AI red team (Phase 25, ADR-0040, `docs/AI-SECURITY-AUDIT.md`):** the
  standing clause now states the trust hierarchy **by name** — SYSTEM/DEVELOPER
  outranks USER which outranks EXTERNAL DATA (anything inside
  `UNTRUSTED_*_BEGIN/END` markers), a lower tier can never override a higher
  one, and the model must never reveal/quote/paraphrase its own system prompt,
  claim to be a different or "jailbroken" system, or treat a user-message
  claim of system/developer/admin authority as real. Two code-level backstops
  don't depend on the model obeying that clause: **output-side secret
  scrubbing** — `agents/output-scrub.ts`'s `scrubModelOutput` deep-walks every
  agent's final output (model-path and deterministic-fallback alike) through
  `scrubSecrets` before persistence/return, catching a compromised response
  that echoes something secret-shaped; and a **forced-confirmation invariant**
  — `agent/orchestrator.ts`'s `finalizeBlocks` sets
  `requiresConfirmation: true` on every `kind: 'external'` proposed action
  unconditionally, so an injection cannot get a "pre-approved" external action
  past grounding (which never examined `proposedActions`). Adversarial
  coverage: `packages/services/src/agents/ai-red-team.test.ts` (instruction
  hijacking / system-prompt extraction, secret exposure, unauthorized
  external actions, cross-tenant access, tool manipulation, indirect
  injection via crawled/social content).
- `external`/`destructive` tool calls require human approval unless the org
  enabled automation mode (explicit, per-scope, revocable, audited).
- Token/step/time/cost budgets per run. **Per-call timeout** (`AI_REQUEST_TIMEOUT_MS`)
  - transient retry (`AI_MAX_RETRIES`) + cross-provider fallback
    (`AI_FALLBACK_MODELS`) in `packages/ai` (`withResilience` / `FallbackProvider`,
    Phase 22). **Kill switch:** `AI_DISABLED` disables every model call,
    `AI_DISABLED_PROVIDERS` disables one provider — checked per call, so no
    redeploy is needed; each analyst still has a deterministic path. **Per-user
    throttle:** `usage.enforceAiUserLimit` (fail-open Redis, `AI_USER_RATE_LIMIT`
    / window) in front of the per-org monthly `AI_REQUESTS` entitlement.
- Model provider calls: no customer PII beyond what the task needs; provider
  data-retention settings configured to the strictest available; prompts and
  completions are customer data (retention per `DATABASE.md`).
- **Content repurposing (ADR-0023):** the engine transforms user-provided or
  already-synced text only — it never fetches or transcribes a URL. It performs
  **no external publish**: `markAssetPublished` is a status marker and the
  scheduled-content sweep only writes an audit row. Content history is
  append-only (immutable `ContentAssetVersion` rows); every project/asset
  transition is audit-logged. Guarded by the `content:manage` action.
- **Unified Growth Agent (Phase 7, ADR-0022):** capabilities receive a
  tenant-scoped `CapabilityContext`, never a raw DB or the ability to widen
  scope by argument; there is no capability that mutates anything. The
  orchestrator **never executes an external-system action** — publish / metadata
  changes are emitted as proposed actions with `requiresConfirmation` and done
  through the owning feature's existing approval flow. Private chain-of-thought
  is never persisted or returned (the `GrowthAgentResponse` schema has no
  reasoning field). Controlled memory (`OrgMemory`) stores only six kinds and
  runs a secret-redaction + length cap on every write, including the model
  extractor's output. Conversation search + export are scoped to the requesting
  user's own conversations.
- **Monetization intelligence (Phase 9, ADR-0024):** the opportunity engine is
  deterministic; the model may only rewrite prose and is dropped on any
  grounding failure — it cannot choose channels or emit numbers. **No
  platform-qualification claim is ever made**: PLATFORM_MONETIZATION readiness is
  derived only from the conservative `assessMonetization` result and the copy
  defers eligibility to the platform. **Revenue is user-entered only** —
  `RevenueEntry.createdById` is required with no default and nothing in the
  module writes a revenue row except the explicit user action; deletes are soft
  so history is preserved. All potential/difficulty values are labelled
  estimates, never currency figures. Promote-to-task never targets an external
  system. Guarded by the `monetization:manage` action; every scan, status
  change, promotion and revenue edit is audit-logged.

## 12. Audit logging

`AuditLog` (append-only) records: sign-in/out, failed auth, session revoke,
membership + role changes, invitations, org create/delete, integration
connect/disconnect, billing/plan changes, recommendation approvals, automation-
mode toggles, agent tool approvals, admin actions, data-export/delete requests.
Fields: actor (+ type), action, target, ip, user-agent, metadata, timestamp.
13 months hot, then cold archive; export available to Enterprise.

## 12a. Admin console & observability (Phase 13, ADR-0028)

- **Access.** `/admin/*` is gated by `requirePlatformStaff()` (a `PlatformStaff`
  row) and, defence-in-depth, by the edge middleware `authorized` callback which
  redirects a non-staff user before the page renders. The console is
  **read-only** — no user / org / subscription mutation.
- **No secrets in admin output.** Four independent layers:
  1. Log redaction — pino `redact` key paths (auth headers, cookies, `*.token`,
     `*.*Secret`, `*.*Cipher`, `*.privateKey`, …).
  2. `scrubSecrets` on every persisted / displayed free-text field
     (`ErrorEvent.message` + `stack`, `Crawl.error`, `OAuthConnection.lastError`,
     `IntegrationHealth.detail`): vendor key prefixes, `Authorization` values,
     JWTs, connection-string credentials, `NAME=value` secret assignments.
  3. Explicit Prisma `select` on every admin query — the `OAuthConnection`
     `accessTokenCipher` / `refreshTokenCipher` / `*Iv` / `*AuthTag` / `keyId`
     columns are **never** read.
  4. Stripe `customer` / `subscription` ids are masked (`cus_ab…wxyz`).
- **`/api/metrics`** (web) and the worker's `:$WORKER_HEALTH_PORT/metrics` are
  never public: a `Bearer $METRICS_TOKEN` (for the scraper) or a platform-staff
  session. `/api/health` is public but only reports `ok | degraded | down` per
  dependency — no versions of secrets, no connection strings; the `?deep=1` AI
  probe is restricted to platform staff.
- **Error events** carry a `correlationId` (resolved from a trusted-proxy
  `x-correlation-id` header or minted) and an optional `organizationId` /
  `actorId` for triage, and are de-duplicated by `fingerprint` so a fault storm
  cannot flood the table. They are non-tenant and retained for forensic
  purposes.
- **Audit.** `/admin` is view-only, so it does not itself write `AuditLog` rows;
  the actions it surfaces are audited at their own call sites (§12).

## 13. Data protection & compliance

- Encryption in transit (TLS 1.2+ everywhere) and at rest (DB, object storage,
  backups). Application-level encryption for OAuth tokens (§5).
- PII inventory maintained; data-processing records for GDPR/CCPA.
- DSR workflows: export (machine-readable) and delete/anonymize within 30 days
  (`DATABASE.md` §13).
- Backups encrypted at rest: `deploy/backup/pg-backup.sh` refuses to run
  without `BACKUP_GPG_RECIPIENT` set (Phase 31 — this was previously
  optional, so an unencrypted dump could ship silently; the script now
  enforces the claim in this line instead of just documenting it).
  Access-controlled: see `docs/DEPLOYMENT.md` §3 for the backup bucket's
  least-privilege key split. **Restore tested quarterly is aspirational,
  not yet true** — `deploy/backup/pg-restore.sh` exists and is reasonable,
  but no evidence in this repo shows it has ever actually been run
  end-to-end (`docs/DEPLOYMENT.md` §18).
- Sub-processor list published (model providers, Stripe, email, hosting).
- DPA available for business/enterprise customers.

## 14. Vulnerability management

- Dependencies: `pnpm audit` in CI (high+ fails soft, tracked), Dependabot/renovate,
  lockfile pinned, `--frozen-lockfile` in CI/deploy.
- SAST: ESLint security rules + CodeQL on PRs.
- DAST / pen test before GA and annually thereafter.
- Container images: minimal base, non-root user, image scan in the pipeline,
  no build tools in the runtime layer.
- Security disclosure policy + `SECURITY.md` contact; triage SLA.

## 15. Incident response (outline)

Detect (alerts) → declare + assign IC → contain (kill switch, revoke, isolate) →
eradicate → recover → post-mortem within 5 business days → customer + regulator
notification per legal timelines. Runbooks: token-key compromise, tenant leak,
crawler misuse, provider key leak, webhook secret leak.

---

## Never expose to the browser

OAuth client secrets · API keys · database credentials · encryption keys ·
service-role keys · private tokens · another tenant's data.
