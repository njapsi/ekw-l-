# INCIDENT-RESPONSE.md

Real, step-by-step runbooks for the ten scenarios `docs/SECURITY.md` §15
previously only named in one sentence. Each follows the same eight-step shape
(detect → contain → investigate → mitigate → recover → communicate →
postmortem → preventive action) and names the actual code, env var, or admin
page this codebase has for that step — not a generic template. Written
(Phase 12) as a paper exercise: **none of these runbooks has been executed
against a real incident or rehearsed as a live drill in this sandbox** (no
production traffic, no real customer data, no on-call rotation exists yet).
That is a real, disclosed gap — see `docs/SECURITY_POSTURE.md`'s risk
register — not a claim that these procedures are battle-tested.

Severity levels used below, borrowed from the general on-call convention this
project has not yet formalized elsewhere:

| Severity | Meaning | Response |
|---|---|---|
| SEV-1 | Active exploitation, confirmed data exposure, or full outage | Immediate, all-hands, customer notification likely required |
| SEV-2 | Confirmed compromise with contained blast radius, or partial outage | Same-day response, notification decided case-by-case |
| SEV-3 | Suspected compromise, no confirmed exposure, or degraded (not down) | Next-business-day response acceptable |
| SEV-4 | Near-miss or a control that fired correctly (e.g., a blocked SSRF attempt) | Logged, reviewed at the next retro, no active response needed |

No paging/alerting system pages a human on any of these triggers yet
(`docs/SECURITY.md` §14, "Still outstanding" in `CLAUDE.md`) — today,
detection is a human noticing something in `/admin`, in logs, or via a
security-event/notification email. That gap is itself tracked in the risk
register.

---

## 1. OAuth token compromise (a connected YouTube/TikTok/Search Console token leaks)

**Scenario:** an `OAuthConnection`'s access/refresh token is suspected leaked
(e.g., found in a log, a support ticket paste, or a third-party breach
notice naming this app).

1. **Detect.** A report (support, a security researcher, or a log-scrubbing
   audit finding an unredacted token — see `docs/SECURITY.md` §4's pino
   redaction list, which should make this structurally rare).
2. **Contain.** From `/admin` (platform staff), locate the affected
   `OAuthConnection` by org/provider. Call the existing disconnect path
   (`integrations.disconnectProvider` / the org's own
   "Disconnect" button in `/app/integrations/*`) — this revokes the token
   upstream (Google/TikTok's revoke endpoint) **and** scrubs the ciphertext
   columns, per `docs/SECURITY.md` §5. If the org cannot or should not act
   themselves (suspected account takeover), platform staff can trigger the
   same service function directly.
3. **Investigate.** Check `IntegrationSyncRun` and `AuditLog` for the
   connection's recent activity — did anything sync or publish using this
   token in an unexpected window? Check `AgentRunEvent`/`AgentRun` for tool
   calls against `youtube.*`/`tiktok.*`/`gsc.*` tools in that window.
4. **Mitigate.** If the leak source is this app (not the user's own
   environment), identify and close it before the org reconnects — a
   reconnect with the same root cause just re-exposes the new token.
5. **Recover.** The org reconnects via the normal OAuth flow
   (`/app/integrations/<provider>`); a fresh token is minted upstream.
6. **Communicate.** Notify the affected org (existing `Notification` +
   email-if-configured path — `notifications` module). If the leak source
   was ours, this is at minimum SEV-2 and likely warrants a direct email,
   not just an in-app notice.
7. **Postmortem.** Within 5 business days: root cause, what let the token
   reach the leak surface, whether `scrubSecrets`/pino redaction should have
   caught it and didn't.
8. **Preventive action.** If a log/output path leaked the token, add it to
   `scrubSecrets`'s patterns (`packages/services/src/observability/scrub.ts`)
   and to the pino redaction list, then confirm with a targeted regression
   test — mirroring how Phase 25's `output-scrub.ts` closed the equivalent
   gap for AI agent output.

## 2. API key compromise (an org's `ApiKey` for `/api/v1/*` leaks)

1. **Detect.** Unexpected `/api/v1/*` traffic pattern, a leaked key found in
   a public repo/paste (a periodic external secret-scan is not yet
   automated — manual/ad hoc today), or the org reports it themselves.
2. **Contain.** The org (or an ADMIN/OWNER with `api_key.revoke`) revokes the
   key from `/app/settings/api-keys` (`revokeApiKeyAction` →
   `apiKeys.revokeApiKey`) — this is immediate; the key is hash-only stored,
   so revocation just flips its status and every subsequent request with
   that key's hash is rejected.
3. **Investigate.** `ApiKey.lastUsedAt` plus the audit log's
   `api_key.created`/`api_key.revoked` events establish a rough usage
   window; `/api/v1/*` doesn't currently emit a per-call audit row (a
   disclosed gap — see the risk register), so a fine-grained request log
   may not exist beyond web-server access logs if any are retained upstream
   of this app.
4. **Mitigate.** Confirm the key's granted scopes (capped at the creator's
   live permissions at creation time) to bound what an attacker could have
   done with it — `ApiKey.scopes`.
5. **Recover.** The org creates a replacement key (`createApiKeyAction`).
6. **Communicate.** In-app notice to the org; direct contact if the key's
   scope included anything `WRITE`/`PUBLISH`-shaped.
7. **Postmortem / 8. Preventive action.** Same shape as §1 — where did the
   leak happen, and does a new automated secret-scan surface need to be
   added (this is the same gap noted for OAuth tokens).

## 3. Database compromise (unauthorized access to Postgres)

1. **Detect.** An anomaly from the managed Postgres provider (Supabase in
   the current staging deployment) — an unrecognized connection source, an
   alert from the provider's own monitoring, or a credential found leaked.
2. **Contain.** Rotate `DATABASE_URL`'s credential immediately at the
   provider (Supabase project settings → database password, or the
   equivalent for whatever managed Postgres production ultimately uses);
   redeploy `web` and `worker` with the new connection string
   (`docker-compose.production.yml`'s `migrate`/`web`/`worker` services all
   read it from the shared `.env.production` — see `docs/DEPLOYMENT.md`).
   If the provider supports it, temporarily restrict the database's network
   allowlist to just the app's egress IP(s).
3. **Investigate.** Query `AuditLog` and `SecurityEvent` for activity
   inconsistent with normal usage in the suspected window (bulk exports, a
   burst of role changes, unfamiliar admin actions). If the provider offers
   query/connection logs, cross-reference those against the app's own known
   connection pool size — an unexplained extra connection source is the
   strongest signal.
4. **Mitigate.** If specific rows are confirmed exfiltrated or tampered
   (e.g., `OAuthConnection` ciphertext columns, though AES-256-GCM means a
   raw column dump alone doesn't yield the plaintext token without
   `ENCRYPTION_KEY` — see §7 below for what to do if that key is *also*
   suspected compromised), treat every OAuth connection and API key in the
   affected orgs as compromised and force reconnect/rotate per §1/§2.
5. **Recover.** Once the credential is rotated and the intrusion vector
   closed, restore from the most recent clean backup if any row-level
   tampering (not just read access) is confirmed — see
   `docs/DISASTER-RECOVERY.md` for the restore procedure; this is the one
   incident type that may also require a full data restore, not just
   containment.
6. **Communicate.** SEV-1 by default. Legal/regulatory notification
   timelines apply (GDPR 72-hour rule if EU personal data is in scope) —
   this app has no in-house legal function; a real incident escalates to
   whoever holds that responsibility for the business immediately, in
   parallel with technical containment, not after.
7. **Postmortem / 8. Preventive action.** How did the credential leak or the
   access happen; whether Postgres RLS (still not implemented — ADR-0035,
   ADR-0061) would have contained the blast radius further, which is exactly
   the argument for prioritizing that follow-up.

## 4. AI provider API key compromise

1. **Detect.** An unexpected bill/usage spike from the AI provider's own
   dashboard, or a leaked key found externally.
2. **Contain.** Immediately set `AI_DISABLED=1` (or
   `AI_DISABLED_PROVIDERS=<provider>` to disable just the affected one) in
   the deployment env and restart `web`/`worker` — `packages/ai`'s
   `withResilience` checks this on every call, so it takes effect without a
   code change (`docs/SECURITY.md` §11). Rotate the actual provider API key
   at the provider's console in parallel.
3. **Investigate.** Provider-side usage logs (token volume, request origin)
   are the primary evidence source — this app's own `AgentRun` rows record
   cost/token usage per run and can help correlate a spike to specific
   orgs/capabilities if the compromise is internal misuse rather than a pure
   external key leak.
4. **Mitigate.** Update `AI_MODEL_*`/provider env with the rotated key;
   clear `AI_DISABLED`.
5. **Recover.** Confirm `/api/health`'s `ai_provider` check reports `ok`
   before considering the incident closed.
6. **Communicate.** Internal only unless customer data was sent to a
   provider outside its agreed retention/use terms — review what capability
   calls occurred during the suspected window.
7. **Postmortem / 8. Preventive action.** Where the key leaked; whether
   provider-side spend alerts/budgets should be configured tighter (a
   provider-side control, not something this app can enforce end-to-end).

## 5. Webhook secret leak (Stripe signing secret)

1. **Detect.** An unauthenticated or malformed webhook call succeeding
   unexpectedly, or the secret found leaked externally. The existing
   `webhook_signature_failures_total` metric (Phase 31) is the earliest
   *negative* signal — a spike there means someone is probing with a wrong
   secret, not that the real one leaked, but it's worth checking during
   triage.
2. **Contain.** Roll `STRIPE_WEBHOOK_SECRET` at Stripe's dashboard
   (Developers → Webhooks → roll secret) and update the deployment env
   immediately — every subsequent webhook call with the old secret fails
   signature verification and returns `400` (`docs/SECURITY.md` §10).
3. **Investigate.** Query `BillingEvent` for any row whose processing looks
   inconsistent with a real Stripe event in the suspected window (the ledger
   is keyed by Stripe's own event id, so a forged event with a guessed/stolen
   id would still need a valid signature to have been accepted at all —
   this scenario is specifically about the secret being known to an
   attacker, not a signature bypass).
4. **Mitigate.** Redeploy with the new secret; confirm `/api/billing/webhook`
   rejects a request signed with the old secret (a quick manual `curl` with
   a deliberately-stale signature is the direct test, matching Phase 31's
   own live verification of the failure-counter fix).
5. **Recover.** Resume normal Stripe webhook delivery; Stripe automatically
   retries any events that failed during the rotation window.
6. **Communicate.** Internal only unless a forged billing event is confirmed
   to have altered a real subscription/entitlement — if so, treat as SEV-2
   and audit every `Entitlement`/`Subscription` row touched by the forged
   event.
7. **Postmortem / 8. Preventive action.** Where the secret leaked; consider
   whether the secret should live in a dedicated secret manager with access
   logging rather than a plain deployment env var (an infra-level follow-up,
   not a code change).

## 6. Admin account compromise (a `PlatformStaff` account is taken over)

1. **Detect.** Unusual `/admin` activity — the admin console is read-only
   (`docs/SECURITY.md` §12a), which bounds the damage a compromised staff
   session can do (no user/org/subscription mutation is possible from
   `/admin` itself), but cross-tenant *reads* are exactly what such an
   account is trusted with, so an anomaly here is still serious. Watch for
   `SecurityEvent` `AUTH_LOGIN` from an unfamiliar network for that user.
2. **Contain.** Sign the account out everywhere: from `/app/settings/security`
   (as that user, if they still control the account) or, if the account
   itself is compromised, an OWNER/platform operator bumps
   `User.sessionVersion` directly (the same mechanism `revokeOtherSessions`
   uses) to invalidate every existing JWT for that user within one request
   cycle (`docs/SECURITY.md` §2). If MFA is not yet enabled on the account,
   enable it immediately as part of containment, not just recovery.
3. **Investigate.** Every `/admin` page read is a cross-tenant read by
   design (`docs/SECURITY.md` §12a) but is not itself individually
   audit-logged today (the console's own note: "does not itself write
   `AuditLog` rows; the actions it surfaces are audited at their own call
   sites") — this is a real visibility gap for exactly this scenario,
   tracked in the risk register. The best available signal is the
   `SecurityEvent` login history for that user plus server access logs if
   retained.
4. **Mitigate.** Revoke the compromised account's `PlatformStaff` row
   (removes admin access entirely) until the account is confirmed clean and
   MFA-protected.
5. **Recover.** Re-grant `PlatformStaff` once the account owner has changed
   their password (or reset it via the existing flow) and enabled MFA.
6. **Communicate.** Internal only, unless specific customer data is confirmed
   viewed and mishandled — SEV-1 if so (an insider-misuse scenario, per the
   threat model in `docs/SECURITY.md` §1).
7. **Postmortem / 8. Preventive action.** This is the strongest concrete case
   for prioritizing a per-admin-page-view audit trail — currently absent —
   and for making MFA **required**, not optional, for every `PlatformStaff`
   account (today MFA is opt-in for every account, staff included).

## 7. `ENCRYPTION_KEY` compromise (the token-envelope key leaks)

1. **Detect.** The key found leaked (a config dump, a compromised deployment
   host, a leaked backup that included plaintext env).
2. **Contain.** Generate a new key (`generateEncryptionKey()` — already a
   real exported function in `crypto/tokens.ts`) and set it as
   `ENCRYPTION_KEY`, moving the old value to `ENCRYPTION_KEY_PREVIOUS`. Every
   row sealed under the old key still opens (`isStaleKeyId` +
   `previousKeyFor`, `docs/SECURITY.md` §5's key-rotation design) so nothing
   breaks mid-rotation.
3. **Investigate.** Because AES-256-GCM ciphertext alone is not exploitable
   without the key, the real risk window is "how long was the leaked key
   valid, and could someone with database read access during that window
   have decrypted OAuth tokens" — cross-reference against §3 (was the
   database itself also accessed).
4. **Mitigate.** The `integrations/lifecycle.ts` token-lifecycle sweep
   already re-seals any row whose `keyId` is stale under the current key on
   its normal cadence — no manual per-row migration needed, but for a
   confirmed leak, don't wait for the sweep: treat every OAuth connection
   that was sealed under the compromised key as **also** compromised and
   force reconnect (§1), since a leaked encryption key plus database read
   access is equivalent to a full token leak for every row sealed under it.
5. **Recover.** Once every affected connection is reconnected under the new
   key, remove `ENCRYPTION_KEY_PREVIOUS`.
6. **Communicate.** SEV-1 — this key protects every connected account's
   credentials across every tenant.
7. **Postmortem / 8. Preventive action.** How the key reached wherever it
   leaked from; whether the deployment should move `ENCRYPTION_KEY` to a
   dedicated secret manager with tighter access control than a plain
   Compose env file.

## 8. Tenant data leak (cross-organization data exposure)

1. **Detect.** A user reports seeing another org's data, or the
   tenant-isolation integration suite (`security/tenant-isolation.
integration.test.ts`) fails in CI — that suite failing at all is itself a
   SEV-1-worthy signal and should block deployment.
2. **Contain.** Identify the specific query/route responsible
   (`scripts/check-tenant-scope.mjs`'s own coverage is the first place to
   check — is the offending model in its `TENANT_MODELS` allowlist at all?
   Phase 12 found and fixed exactly this gap for 21 models). If the leak is
   live and the fix isn't immediate, consider taking the specific affected
   feature/route offline (a feature flag or a temporary route-level 503)
   rather than the whole app, if the blast radius is narrow enough to
   isolate.
3. **Investigate.** Determine exactly which orgs' data was exposed to which
   other org(s), and for how long the vulnerable code path had existed
   (check git blame / deployment history for when the unscoped query was
   introduced).
4. **Mitigate.** Ship the scoping fix; add the affected model to
   `check-tenant-scope.mjs`'s allowlist if it was missing so CI would have
   caught it, and add a targeted cross-tenant integration test reproducing
   the exact leak before the fix (matching this project's own "write the
   failing test first" pattern from every prior security phase).
5. **Recover.** Deploy the fix; re-run the full tenant-isolation suite.
6. **Communicate.** SEV-1. Every affected organization needs direct
   notification naming what was exposed — this is the single scenario this
   document treats as always warranting proactive customer communication,
   not a case-by-case call.
7. **Postmortem / 8. Preventive action.** Whether Postgres RLS (still not
   implemented) would have made this class of bug structurally impossible
   rather than dependent on a lint catching it — this is the standing
   argument for prioritizing ADR-0061's RLS retrofit.

## 9. Crawler misuse (the SEO crawler used against a target the operator doesn't own, or as an SSRF vector)

1. **Detect.** A crawl of an unverified/suspicious target, an abuse report
   from a third party whose site was crawled, or a `CrawlIssue`/`Crawl.error`
   pattern suggesting the crawler reached somewhere it shouldn't have.
2. **Contain.** Set `CRAWLER_HALT=1` globally, or `CRAWLER_HALT_ORG_IDS=<id>`
   for the specific org, immediately (`docs/SECURITY.md` §7) — checked at
   plan time and at every page, so an in-flight crawl for that org/globally
   stops within one page.
3. **Investigate.** Review the `Website.verified`/`verificationMethod` trail
   for the target — did ownership verification (DNS TXT or the
   `.well-known` file) actually pass, and was it later invalidated? Review
   `CrawlPage`/`CrawlLink` for evidence of what the crawler actually reached
   (the SSRF guard should have refused any private/internal/metadata
   address outright — if one was reached, that is a BLOCKER-class bug in
   `seo/ssrf.ts` itself, not just a misuse case, and escalates accordingly).
4. **Mitigate.** If ownership verification was bypassed some other way (not
   an SSRF-guard bug), fix that specific gap; if it's confirmed pure product
   misuse by a legitimate account (crawling a competitor's unverified site,
   say), this is an acceptable-use-policy matter, not a security bug —
   suspend the account per the org's terms.
5. **Recover.** Clear the kill switch once the specific issue is resolved.
6. **Communicate.** Notify the crawled third party if their infrastructure
   was materially affected (load, unexpected traffic pattern).
7. **Postmortem / 8. Preventive action.** If any private/internal address
   was reached, this is the highest-priority finding possible — re-run the
   full `ssrf.test.ts` suite and the live-reproduction technique
   `docs/CRAWLER-SECURITY-AUDIT.md` used to find the three real bugs Phase 24
   fixed, since this exact class of bug has a track record of hiding behind
   passing unit tests until tested live.

## 10. Growth Mission misuse (a mission takes an unintended real-world action)

1. **Detect.** A user reports an unexpected published post, content
   generation, or external change they didn't approve; a spike in
   `IntegrationActionRequest` volume from one mission.
2. **Contain.** Set `MISSIONS_HALT=1` (or `MISSIONS_HALT_ORG_IDS=<id>`,
   Phase 12, §9b above) immediately — stops every tick, scheduled and
   manual alike.
3. **Investigate.** Every WRITE/PUBLISH-shaped tool a mission can call only
   ever *files a pending approval*, never executes directly (Phases 6-9's
   own structural convention, unchanged by Phase 10's mission layer) — so
   the first question is always "who approved this, and should they have
   been able to." Check `IntegrationActionRequest.sourceMissionTaskId` back
   to the originating `MissionTask`, and the approver's role at the time
   (`decideActionRequest`'s own re-checked authorization).
4. **Mitigate.** If the approval itself was legitimate but the mission's
   plan was wrong (a planner bug producing a bad task), pause the specific
   mission (`missions` UI) rather than halting every mission org-wide.
5. **Recover.** Resume once the specific issue (a bad plan, a
   misunderstood autonomy level, an over-permissioned approver) is
   addressed; clear the kill switch.
6. **Communicate.** Direct to the affected org if a real external action
   (a publish, a WordPress update) went out that they didn't intend.
7. **Postmortem / 8. Preventive action.** Whether the mission's autonomy
   level (`missions/policy.ts`) was set appropriately for the action that
   occurred, and whether the weekly publish/content-generation throttles
   (`maxPublishPerWeek`/`maxContentGenerationsPerWeek`) would have limited
   the blast radius further if lower.

---

## Where these plug into the rest of the system

- **Kill switches referenced above:** `CRAWLER_HALT`/`CRAWLER_HALT_ORG_IDS`,
  `MISSIONS_HALT`/`MISSIONS_HALT_ORG_IDS` (Phase 12), `AI_DISABLED`/
  `AI_DISABLED_PROVIDERS`.
- **Revocation primitives referenced above:** `revokeSessionByHandle`,
  `revokeOtherSessions` (+ `sessionVersion` bump), OAuth `disconnectProvider`
  (upstream revoke + ciphertext scrub), `revokeApiKeyAction`, MFA
  `disableMfa`, `ENCRYPTION_KEY_PREVIOUS` rotation.
- **What this document does not cover:** infrastructure loss (host failure,
  data corruption without malicious intent) — see `docs/DISASTER-RECOVERY.md`
  instead. The two documents share the same eight-step shape deliberately,
  but disaster recovery starts from "something failed," not "someone did
  something."
