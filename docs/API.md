# API.md

The API is **internal-first**: consumed by the Growth Agent web app. A public
customer API is post-MVP (`ROADMAP.md`). Style, contracts, and cross-cutting
rules below apply to every endpoint and Server Action.

---

## 1. Shape & transport

- **Two entry styles, one service layer.**
  - **Server Actions** for mutations driven by the app UI (forms, buttons).
    Typed, CSRF-safe by construction, colocated with the feature.
  - **Route Handlers** (`apps/web/app/api/**`, REST-ish JSON) for: OAuth
    callbacks, webhooks, polling/streaming (agent runs, job status), file
    download redirects, health/metrics, and anything a non-browser client calls.
- Both call the same `packages/services` functions. No business logic in
  handlers/actions.
- JSON only (`application/json`), UTF-8. Streaming responses use SSE
  (`text/event-stream`) for agent tokens and job progress.
- Base path `/api/v1` for REST handlers. Additive changes only within `v1`;
  breaking changes → `/api/v2`.

---

## 2. Authentication

- **Session:** Auth.js database session cookie (`HttpOnly`, `Secure`,
  `SameSite=Lax`). Establishes the `actor` (`User`).
- **Service tokens (post-MVP public API):** opaque bearer tokens, hashed at
  rest, scoped to one organization + a permission set, shown once on creation,
  revocable, with `lastUsedAt`.
- **Webhooks (inbound):** no session; verified by provider signature (Stripe
  `Stripe-Signature`, Google/TikTok per provider). Unsigned/invalid → 400, not
  processed.
- **Internal (web→worker):** not an API — shared queue + DB. The worker exposes
  only `/healthz` and `/metrics` on a private interface.

---

## 3. Authorization

Every endpoint resolves, in order:

1. **Actor** from session/token. None → `401 unauthenticated`.
2. **Organization** from the route (`/api/v1/orgs/{orgId}/...`) or the session's
   active org for Server Actions. The `orgId` is validated against the actor's
   **active** memberships — never trusted blindly.
3. **Membership + role.** No membership → `404` (not `403`, to avoid resource
   enumeration).
4. **Permission.** `authorize(actor, org, action)` maps `(role, action) →
allow/deny` from a single policy table. Metered actions also pass
   `usage.check`.
5. **Admin** endpoints (`/api/v1/admin/**`) require `PlatformStaff`; they are
   explicitly cross-tenant and every call is audit-logged.

RBAC matrix (MVP):

| Action class                                        | OWNER | ADMIN | MEMBER | VIEWER |
| --------------------------------------------------- | ----- | ----- | ------ | ------ |
| View data, reports, recommendations                 | yes   | yes   | yes    | yes    |
| Run crawls / agent tasks                            | yes   | yes   | yes    | no     |
| Manage content repurposing (`content:manage`)       | yes   | yes   | yes    | no     |
| Manage monetization (`monetization:manage`)         | yes   | yes   | yes    | no     |
| Generate / delete reports (`report:generate`)       | yes   | yes   | yes    | no     |
| Manage automations (`automation:manage`)            | yes   | yes   | yes    | no     |
| Approve recommendations / publishing                | yes   | yes   | no     | no     |
| Create / revoke report share links (`report:share`) | yes   | yes   | no     | no     |
| Manage integrations                                 | yes   | yes   | no     | no     |
| Manage members / roles                              | yes   | yes   | no     | no     |
| Billing, plan changes, delete org                   | yes   | no    | no     | no     |

---

## 4. Validation

- **Input:** every handler/action parses input with a **Zod** schema from (or
  re-exported through) `packages/core`. Unknown keys rejected. No raw
  `req.json()` reaches a service.
- **Output:** responses are built from typed service results and validated in
  non-production (and for AI-generated structured data, always) before send.
- **IDs:** path/query IDs are format-checked (`cuid`) before any DB call.
- **Size limits:** JSON body ≤ 1 MB (webhooks ≤ 256 KB); uploads go through
  presigned S3 PUT, not the API.

---

## 5. Pagination

- **Cursor-based** only. Request: `?limit=<1..100, default 25>&cursor=<opaque>`.
- Response envelope:
  ```json
  { "data": [ ... ], "page": { "nextCursor": "…"|null, "hasMore": true } }
  ```
- Cursor encodes `(sortKey, id)`; stable under inserts. Offset pagination is not
  offered.
- List endpoints document their fixed sort (usually `createdAt desc, id desc`)
  and allowed filters.

---

## 6. Errors

Standard envelope, correct HTTP status, no stack traces or secrets:

```json
{
  "error": {
    "code": "resource_not_found",
    "message": "Human-readable, safe for display.",
    "details": [{ "path": "input.rootUrl", "issue": "must be http(s)" }],
    "requestId": "req_01H…"
  }
}
```

| HTTP | `code` examples                                                            |
| ---- | -------------------------------------------------------------------------- |
| 400  | `validation_failed`, `malformed_request`, `unsupported_media_type`         |
| 401  | `unauthenticated`, `session_expired`                                       |
| 403  | `permission_denied`, `automation_disabled`                                 |
| 404  | `resource_not_found` (also for cross-tenant access)                        |
| 409  | `conflict`, `already_exists`, `crawl_in_progress`                          |
| 422  | `unprocessable` (semantically invalid but well-formed)                     |
| 429  | `rate_limited`, `usage_limit_exceeded` (+ `Retry-After`)                   |
| 5xx  | `internal_error` (opaque; `requestId` for support), `provider_unavailable` |

Errors are typed `Result` values in services; the handler maps them. Nothing is
silently swallowed.

---

## 7. Rate limits & abuse protection

- **Layered:** edge/CDN coarse IP limits → per-identity application limits
  (Redis token bucket) → per-org **usage limits** (billing).
- Buckets (indicative): auth/login `10/min/IP`; magic-link send `5/hour/email`;
  general authed API `600/min/org` + `120/min/user`; crawl start
  `constrained by tier`; agent run start `tier`; report export `20/hour/org`;
  webhooks: not limited but deduped by event id.
- **Implemented so far** (`packages/services/src/security/rate-limit.ts`,
  ADR-0029 — a **fail-open** fixed-window Redis counter): magic-link send
  `5/hour/email` (via the Auth.js `signIn` callback); OAuth connect
  `15/10min/user` + callback `20/10min/IP`; agent stream `20/min/org+user`;
  crawl start `10/10min/org`; `GET /api/health` `240/min/IP` (+ a 4 s cache).
  The OAuth **callback is also session-bound** — it rejects a signed `state`
  whose `userId` is not the signed-in user. The full edge/IP layer is roadmap
  "Phase 3".
- Response headers on limited routes: `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`, and `Retry-After` on 429.
- Abuse signals (repeated 401/403, crawl of unverified hosts, token-refresh
  storms) raise Admin → abuse-monitoring events.

---

## 8. Idempotency

- Mutating REST endpoints accept `Idempotency-Key`; the key + response are
  cached (Redis, 24 h) so retries don't double-execute.
- Job enqueue endpoints derive a natural idempotency key (e.g.
  `crawl:{websiteId}:{configHash}:{minuteBucket}`) and return the existing job
  if one matches.
- Webhook processing is idempotent on the provider event id (stored, unique).

---

## 9. Webhooks

**Inbound**

| Source                          | Path                      | Verify                               | Handles                                            |
| ------------------------------- | ------------------------- | ------------------------------------ | -------------------------------------------------- |
| Stripe                          | `/api/v1/webhooks/stripe` | `Stripe-Signature` + endpoint secret | subscription lifecycle, invoices, payment failures |
| Google (Pub/Sub push, optional) | `/api/v1/webhooks/google` | OIDC token audience                  | token revocation, quota notices                    |
| TikTok                          | `/api/v1/webhooks/tiktok` | provider signature                   | connection revocation (where supported)            |

Rules: verify **before** parsing; respond `2xx` fast after enqueuing internal
processing; never do slow work in the request; replay-safe via event-id
dedupe; failures retried by the provider and by an internal reconcile job.

**Outbound** (customer-facing): post-MVP. Design: per-org signing secret,
`event` + `data`, HMAC-SHA256 signature header, at-least-once with retry +
backoff, delivery log, manual replay from Admin.

---

## 10. Background jobs (API surface)

Long operations never block a request. Pattern:

1. `POST /api/v1/orgs/{orgId}/{resource}` → `202 Accepted`,
   `{ "job": { "id": "job_…", "status": "queued", "type": "crawl.run" } }`.
2. Poll `GET /api/v1/orgs/{orgId}/jobs/{jobId}` **or** subscribe
   `GET /api/v1/orgs/{orgId}/jobs/{jobId}/events` (SSE: `progress`, `log`,
   `completed`, `failed`).
3. On completion the result resource is addressable
   (`GET …/crawls/{crawlId}`), and a `Notification` is created.

Job status: `queued | active | completed | failed | delayed | cancelled`, with
`progress` (0–100), `attemptsMade`, and a safe `failedReason`.

---

## 11. Endpoint map (MVP, abridged)

```
Auth / session
  POST   /api/auth/*                         (Auth.js handlers)
Organizations
  POST   /api/v1/orgs                        create
  GET    /api/v1/orgs                        list mine
  GET    /api/v1/orgs/{orgId}
  PATCH  /api/v1/orgs/{orgId}                (OWNER)
  POST   /api/v1/orgs/{orgId}/invitations
  POST   /api/v1/invitations/{token}/accept
  GET    /api/v1/orgs/{orgId}/members
  PATCH  /api/v1/orgs/{orgId}/members/{id}   role/status
Billing
  POST   /api/v1/orgs/{orgId}/billing/checkout-session
  POST   /api/v1/orgs/{orgId}/billing/portal-session
  GET    /api/v1/orgs/{orgId}/billing/subscription
  GET    /api/v1/orgs/{orgId}/usage
Integrations
  GET    /api/v1/orgs/{orgId}/integrations
  GET    /api/v1/orgs/{orgId}/integrations/{provider}/connect     -> redirect
  GET    /api/v1/integrations/{provider}/callback                 (OAuth return)
  DELETE /api/v1/orgs/{orgId}/integrations/{id}
YouTube / TikTok
  GET    /api/v1/orgs/{orgId}/youtube/channels
  POST   /api/v1/orgs/{orgId}/youtube/channels/{id}/sync          -> job
  GET    /api/v1/orgs/{orgId}/youtube/videos?channelId=&cursor=
  GET    /api/v1/orgs/{orgId}/tiktok/accounts
  POST   /api/v1/orgs/{orgId}/tiktok/accounts/{id}/sync           -> job
SEO   (Phase 5: implemented as Server Actions in apps/web/src/server/seo-actions.ts,
       backed by @growth-agent/services/seo; the REST shape below is the planned
       public surface. `SEOProject` was folded into `Website`.)
  addWebsiteAction(url)                        perm integration:manage
  verifyWebsiteAction(websiteId)               perm integration:manage  (DNS TXT / HTML file)
  startCrawlAction(websiteId, {maxPages,maxDepth,renderMode})  perm crawl:run   (runs inline; queue-ready)
  pauseCrawlAction / cancelCrawlAction / resumeCrawlAction(crawlId)  perm crawl:run
  runSeoAuditSummaryAction(crawlId)            perm agent:run
  reads: seo.listWebsites / getWebsite / listCrawls / getCrawlOverview /
         listCrawlIssues / listCrawlPages / getArchitecture (all org-scoped)
  POST   /api/v1/orgs/{orgId}/seo/websites
  POST   /api/v1/orgs/{orgId}/seo/websites/{id}/verify
  POST   /api/v1/orgs/{orgId}/seo/websites/{id}/crawls            -> job
  GET    /api/v1/orgs/{orgId}/seo/crawls/{id}
  GET    /api/v1/orgs/{orgId}/seo/crawls/{id}/pages?cursor=
  GET    /api/v1/orgs/{orgId}/seo/crawls/{id}/issues?severity=&cursor=
AI
  POST   /api/v1/orgs/{orgId}/ai/conversations
  POST   /api/v1/orgs/{orgId}/ai/conversations/{id}/messages       (SSE stream)
  POST   /api/v1/orgs/{orgId}/ai/runs                              -> job (agent task)
  GET    /api/v1/orgs/{orgId}/ai/runs/{id}
  POST   /api/v1/orgs/{orgId}/ai/tool-calls/{id}/approve|reject
AI Growth Agent   (Phase 7: implemented at these exact paths + Server Actions)
  POST   /api/agent/stream                       perm agent:run — SSE turn
         body {message, conversationId?}; frames: {type:status|token|done|error}
  GET    /api/agent/search?q=                     title + message-content search (own conversations)
  GET    /api/agent/conversations/{id}/export?format=md|json   file download
  Server Actions (apps/web/src/server/agent-actions.ts):
    renameConversationAction / deleteConversationAction
    createTaskFromRecommendationAction / createAdHocTaskAction / updateTaskStatusAction   perm agent:run
    setGoalAction (manual OrgMemory goal/preference)                                       perm agent:run
  reads: agent.listConversations / getConversation / searchConversations / listTasks
  The agent NEVER calls an external-mutation endpoint. External actions are proposed
  with requiresConfirmation and done via the owning feature's approval screen.

Content repurposing   (operator's "Phase 8": implemented as Server Actions in
                       apps/web/src/server/content-actions.ts; perm content:manage)
  createRepurposeProjectAction({sourceKind, youTubeVideoId?|url?|transcript?|body?, title?, ...})
  analyzeProjectAction(projectId)                     SOURCE → ANALYSIS → KEY IDEAS → ANGLES
  generateAssetsAction(projectId, types?)             → ContentAsset + v1 version (DRAFT)
  editAssetAction / regenerateAssetAction / revertAssetAction   (append a version; reset to DRAFT)
  approveAssetAction / scheduleAssetAction / unscheduleAssetAction
  markPublishedAction / markFailedAction / resetAssetAction     (status only — the engine never publishes)
  reads: content.listProjects / getProject / getAsset / listAssetVersions / listDueScheduled
  worker: content-pipeline queue (analyze | generate | sweep.scheduled — sweep only audits, does not post)

Monetization intelligence   (operator's "Phase 9": Server Actions in
                             apps/web/src/server/monetization-actions.ts; perm monetization:manage)
  saveBusinessProfileAction({niche?, audienceDescription?, offerings?, goals?, emailListSize?, flags…, attestations…})
  runMonetizationScanAction()                         gather signals → deterministic opportunities → grounded prose (optional)
  updateOpportunityStatusAction(id, status, reason?)  SUGGESTED/IN_PROGRESS/ACTIVE/COMPLETED/DISMISSED
  promoteOpportunityToTaskAction(id)                  → Task (never targets an external system)
  addRevenueEntryAction / deleteRevenueEntryAction    revenue is USER-ENTERED ONLY; delete is soft (keeps history)
  reads: monetization.getMonetizationDashboard / getBusinessProfile / listOpportunities / getRevenueSummary
  Estimates are labels (Low/Moderate/High), never dollar amounts. PLATFORM_MONETIZATION never claims the
  creator qualifies — eligibility is the platform's decision. The scan runs inline (no worker queue added).

Billing & usage   (operator's "Phase 10": Server Actions in
                   apps/web/src/server/billing-actions.ts; perm billing:manage — OWNER only)
  startCheckoutAction(tier, interval)      → { url } Stripe-hosted Checkout
  openBillingPortalAction()               → { url } Stripe Billing Portal
  changePlanAction(tier, interval)        upgrade/downgrade an existing sub, or → { url } checkout if none
  cancelSubscriptionAction()             cancel at period end (access kept until then)
  resumeSubscriptionAction()             clear a pending cancellation
  reads: billing.getBillingSummary (plan · status · usage snapshot · invoices), billing.isBillingConfigured
  POST /api/billing/webhook              public; Stripe-signature-verified; idempotent (BillingEvent ledger +
                                        stripe-id-keyed upserts). Bad signature → 400; unknown type → 200 skipped.
  Server-side limit enforcement: usage.enforceUsage(meter) is called BEFORE metered work in the SEO crawl,
  content-generation and agent-stream paths and the OAuth connect routes; over-limit → 429 usage_limit_exceeded.
  The browser is never trusted for a billing or limit decision. Plans/prices come from the config catalog
  (billing/plans.ts), never hard-coded per call site. With no STRIPE_* env the app runs FREE-for-all, limits
  still enforced, and mutating billing calls return provider_unavailable.

Reporting   (operator's "Phase 11": Server Actions in apps/web/src/server/report-actions.ts)
  generateReportAction({type, websiteId?, title?})   perm report:generate; enforces the REPORTS meter first;
                                                     builds an immutable snapshot; FAILED reports keep an error
  deleteReportAction(reportId)                        perm report:generate
  createShareLinkAction(reportId, expiresInDays?)     perm report:share (ADMIN+) → { shareUrl }
  revokeShareLinkAction(reportId)                     perm report:share
  reads: reports.listReports / getReport / reportTypeAvailability                perm report:read
  GET /app/reports/{id}/export?format=pdf|csv|json    authenticated (report:read); rendered from the snapshot
  GET /r/{token}                                      PUBLIC; serves a REDACTED snapshot; unknown/expired/revoked → 404
  GET /r/{token}/export?format=pdf|csv|json           PUBLIC; the SAME redacted snapshot; x-robots-tag: noindex
  Every report has the seven sections: Executive Summary · Key Metrics · Problems · Opportunities ·
  Recommendations · Priority Actions · Historical Changes (diff vs the previous report of the same type).
  Snapshots are immutable — a regenerate is a new row. No private account info is served through /r/{token}.
  Worker: report-generation queue (generate). See docs/REPORTING.md.

Automation engine   (operator's "Phase 12": Server Actions in apps/web/src/server/automation-actions.ts;
                     perm automation:manage — MEMBER+)
  createAutomationAction({name, taskType, cadence, cronExpression?, hour?, minute?, weekday?, monthday?, config?})
  updateAutomationAction(id, {…})            recomputes the schedule + re-checks the owner's permission
  setAutomationStatusAction(id, ACTIVE|PAUSED)   resume clears FAILING/failureCount and reschedules
  deleteAutomationAction(id) · runAutomationNowAction(id) · cancelAutomationRunAction(id, runId)
  reads: automation.listAutomations / getAutomation (rule + last 50 runs = the execution log)
  taskType ∈ { YOUTUBE_ANALYSIS, TIKTOK_ANALYSIS, WEBSITE_CRAWL, SEO_ISSUE_ALERT, MONETIZATION_SCAN,
               GROWTH_REPORT, CONTENT_OPPORTUNITY }; each has one requiredAction; NONE publishes externally.
  Every run re-checks the OWNER's RBAC — an automation can never exceed its owner's permissions (→ SKIPPED,
  rule PAUSED, if the owner lost the role). Idempotent per tick (@@unique(ruleId, scheduledFor)); failed runs
  retry with exponential backoff up to maxRetries; 5 consecutive failures → FAILING, 10 → DISABLED.
  Worker: `automation` BullMQ queue with two repeatable ticks — sweep (60s) and retry-sweep (30s). Schedules
  are UTC. See docs/AUTOMATION.md.

Admin & observability   (operator's "Phase 13": route group apps/web/app/(admin)/admin/*;
                         gated by requirePlatformStaff() + the edge `authorized` callback; READ-ONLY)
  /admin                 overview: platform counts + health strip + recent errors
  /admin/users           listUsers (email/name search); /admin/organizations, /admin/organizations/{id}
  /admin/subscriptions   listSubscriptions + tier/status rollup; Stripe ids masked
  /admin/usage           usageOverview (from UsageCounter, current period, all tenants)
  /admin/ai-usage        aiUsageSummary (tokens · est. cost · latency p50/p95 · by provider/model/agent)
  /admin/agent-runs      listAgentRuns (status/agent/org filters)
  /admin/crawler-jobs    crawlerSummary + listCrawls (errors scrubbed)
  /admin/integrations    listOAuthConnections — token-cipher columns NEVER selected
  /admin/errors, /admin/errors/{id}   de-duplicated ErrorEvent rows (message + stack secret-scrubbed)
  /admin/audit-logs      listAuditLogs (action/org/actor filters)
  /admin/system-health   runHealthChecks + the ten operational metrics + pg_stat_* + worker fleet
  /admin/jobs            getQueueDepths + getAllRecentFailedJobs + getRepeatableTicks + heartbeats
  GET /api/health        PUBLIC; always 200; body status ∈ ok|degraded|down over
                         { database, redis, ai_provider, external_integrations, worker }; ?deep=1 = staff-only AI probe
  GET /api/metrics       Prometheus text; requires `Bearer $METRICS_TOKEN` OR a platform-staff session — never public
  Worker: GET :$WORKER_HEALTH_PORT/healthz (200 iff Redis ready, else 503) and /metrics.
  Metrics registry is in-process + per-instance (resets on deploy); durable dashboard numbers come from
  AgentRun / Crawl / AutomationRun / pg_stat_*. A correlation id is resolved per request in the
  observability layer (x-correlation-id from a trusted proxy, else minted) and threaded into jobs.
  See docs/OBSERVABILITY.md.

Recommendations / Tasks / Reports / Notifications
  GET    /api/v1/orgs/{orgId}/recommendations?domain=&status=&cursor=
  POST   /api/v1/orgs/{orgId}/recommendations/{id}/approve|reject|apply
  POST   /api/v1/orgs/{orgId}/recommendations/{id}/promote-to-task
  CRUD   /api/v1/orgs/{orgId}/tasks
  POST   /api/v1/orgs/{orgId}/reports                              -> job
  GET    /api/v1/orgs/{orgId}/reports/{id}/download                -> presigned redirect
  GET    /api/v1/orgs/{orgId}/notifications?cursor=
  POST   /api/v1/orgs/{orgId}/notifications/{id}/read
Jobs (generic)
  GET    /api/v1/orgs/{orgId}/jobs/{jobId}
  GET    /api/v1/orgs/{orgId}/jobs/{jobId}/events                  (SSE)
Admin (PlatformStaff)
  GET    /api/v1/admin/organizations|users|subscriptions|usage
  GET    /api/v1/admin/jobs|errors|audit-logs|health
Platform
  GET    /api/health        /metrics        (private)
```

---

## 12. Conventions checklist (every endpoint)

- [ ] Zod input schema; unknown keys rejected
- [ ] Actor + org + role + permission resolved via `authorize`
- [ ] Tenant-scoped repository calls only
- [ ] Metered? `usage.check` before, `usage.record` after
- [ ] External mutation? approval record unless automation mode
- [ ] Audit-logged if security-relevant
- [ ] Standard error envelope; typed `Result` mapping
- [ ] Rate-limit bucket assigned
- [ ] Idempotency handled for mutations
- [ ] Correlation id (`requestId`) in logs + response on error
- [ ] Contract test (happy path + auth failure + validation failure + isolation)
