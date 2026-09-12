# DATABASE.md

PostgreSQL 16 via Prisma. This document is the **design**; the schema is
implemented incrementally per `ROADMAP.md`, each phase with its own checked-in
migration.

**Implemented so far** (`packages/db/prisma/schema.prisma`):

- _Phase 2_ — identity + tenancy + RBAC: `User`, `UserProfile`,
  `UserPreference`, `Account`, `Session`, `VerificationToken`, `Organization`,
  `Membership`, `Invitation`, `PlatformStaff`, `AuditLog`.
- _YouTube phase_ — `OAuthConnection` (encrypted-token envelope columns),
  `IntegrationHealth`, `YouTubeChannel`, `YouTubeVideo`, `YouTubeMetric`
  (append-only daily), `YouTubeSyncRun`, and the shared `AgentRun`,
  `Recommendation` (with `reasoning` + `expectedImpact` + `evidence` Json),
  `ContentIdea`.
- _TikTok phase_ — `TikTokAccount`, `TikTokVideo`, `TikTokMetric` (manual
  snapshot — TikTok has no daily analytics), `TikTokSyncRun`, and `TikTokPublish`
  (one authorized publish attempt: status, privacy, caption, hashtags,
  `contentHash` dedupe key, `approvedById`/`approvedAt`, TikTok `publishId`).
- _SEO phase_ (migration `20260908120000_seo_crawler`) — `Website`
  (`hostname` unique per org, `verified` + `verificationMethod` +
  `verificationToken`, cached `robotsTxtCache`), `Crawl` (`status CrawlStatus`,
  `renderMode CrawlRenderMode`, `config`/`summary`/`scores` Json, progress
  counters, `pauseRequested`/`cancelRequested` flags, `blockedReason`),
  `CrawlPage` (`@@unique([crawlId, normalizedUrl])`, the full PAGE ANALYSIS
  field set: status/redirects/canonical/robots/title/meta/headings/links/
  images/JSON-LD/OG/Twitter/hreflang/`contentHash`/`simhash`/security headers/
  `csrLikely`), `CrawlLink` (directed link-graph edge), `CrawlIssue`
  (`@@unique([crawlId, code, normalizedUrl])`, `category` + `severity
CrawlIssueSeverity` + `status CrawlIssueStatus` + `evidence` Json +
  `recommendedFix` + `confidence` + `affectedUrlCount`). The design's
  `SEOProject` / `SEORecommendation` were folded into `Website` + the shared
  `Recommendation` (`domain = SEO`). `CrawlStatus` adds `PAUSED` to the design
  list. Raw HTML is **not** stored yet (object storage deferred — ROADMAP
  Phase 6).
- _AI SEO Agent phase_ (migration `20260909120000_seo_agent`) — additive
  columns only. `Recommendation` gains `priorityScore Float?`, `actionPlan
String?` (`quick_win` | `high_impact` | `technical_project` | `long_term`),
  `affectedUrlCount Int?`, `businessImportance String?`. `CrawlPage` gains
  `landmarkCount Int`, `hasMainLandmark Boolean`, `jsonLdEntities Json`
  (`{ type, name?, url?, id?, sameAs }[]`) for the machine-readability analysis;
  the crawler also now writes `inboundInternalCount` back onto each page at
  finalize.
- _Unified AI Growth Agent phase_ (migration `20260910120000_growth_agent`) —
  `AIConversation` (per-user chat thread, soft-deletable, `lastMessageAt`),
  `AIMessage` (`role AIMessageRole`, `content`, `blocks Json?` = the structured
  `GrowthAgentResponse` for assistant turns, `agentRunId?`), `OrgMemory`
  (`kind MemoryKind` — one of six; `userId?` scopes user-specific goals/prefs;
  `value` secret-redacted + length-capped at write time; optional `expiresAt`),
  `Task` (`status TaskStatus`, `priority`, `domain`, `instructions`,
  `affectedUrls String[]`, `sourceRecommendationId?`, `sourceConversationId?`,
  `requiresExternalAction` + `externalActionKind?` — external actions are
  proposed, never executed by the agent). The design's
  `AIConversation.context` / semantic-memory `pgvector` and `AgentToolCall`
  land with the general orchestrator.

- _Content repurposing phase_ (migration `20260911120000_content_repurposing`) —
  `RepurposeProject` (`sourceType RepurposeSourceType`, `status
RepurposeProjectStatus`, the source fields — `sourceYouTubeVideoId?`,
  `sourceUrl?`, `sourceTitle?`, `sourceDescription?`/`sourceTranscript?`/
  `sourceBody?` `@db.Text`, `sourceTags[]`, `sourceDurationSec?` — plus
  `analysis Json?` = `ContentAnalysis`, `analysisAgentRunId?`,
  `analysisGrounded`), `ContentAsset` (one editable deliverable: `type
ContentAssetType` — the 13 kinds, `platform`, `status ContentAssetStatus`
  DRAFT/APPROVED/SCHEDULED/PUBLISHED/FAILED, `currentVersionId @unique`,
  `sourceAngle?`, `scheduledFor?`, `publishedAt?`, `publishTarget?`,
  `failureReason?`, `createdByAgentRunId?`, `approvedById?`/`approvedAt?`),
  `ContentAssetVersion` (immutable linear history: `versionNumber`,
  `body @db.Text`, `structured Json?`, `editedById?` — null ⇒ AI-generated,
  `editSummary?`; `@@unique([contentAssetId, versionNumber])`). The engine
  never publishes — `markAssetPublished` only sets the status.

- _Monetization phase_ (migration `20260912120000_monetization`, additive) —
  `BusinessProfile` (one per org, `@unique organizationId`; every field
  user-entered: `niche?`, `audienceDescription? @db.Text`, `offerings[]`,
  `goals[]`, `emailListSize Int?`, activity flags `hasWebsite` /
  `sellsProducts` / `doesSponsorships` / `doesAffiliates` / `doesConsulting` /
  `hasMembership` / `hasCourse`, `attestations Json?` = YPP self-attestation,
  `notes? @db.Text`), `MonetizationOpportunity` (`channel MonetizationChannel`
  — 11 kinds, `status OpportunityStatus` SUGGESTED/IN_PROGRESS/ACTIVE/
  COMPLETED/DISMISSED, `evidence Json`, `audienceFit`, `difficulty`,
  `potential` = the label `Low`/`Moderate`/`High` — **never a number**,
  `potentialBasis @db.Text`, `requiredActions[]`, `confidence Float`,
  `isEstimate Boolean @default(true)`, `priorityScore Float?`,
  `sourceAgentRunId?`, `dismissedReason?`, `completedNote?`;
  `@@unique([organizationId, channel])`), `RevenueEntry` (**user-entered
  only** — `createdById` is required with no default; `channel`, `source`,
  `amount Decimal @db.Decimal(14,2)`, `currency`, `periodStart`/`periodEnd
@db.Date`, `isRecurring`, `note?`, `deletedAt?` — soft delete keeps
  history). `enum MonetizationChannel` = PLATFORM_MONETIZATION · SPONSORSHIP ·
  AFFILIATE · DIGITAL_PRODUCT · SERVICE · MEMBERSHIP · SUBSCRIPTION ·
  LEAD_GENERATION · CONSULTING · COURSE · BRAND_PARTNERSHIP.

- _Billing & usage phase_ (migration `20260913120000_billing`, additive) —
  `Subscription` (1:1 org), `Entitlement`, `UsageRecord`, `UsageCounter`,
  `Invoice`, and the non-tenant `BillingEvent` webhook-idempotency ledger. Plan
  definitions are a config catalog, not a table (ADR-0025). See §3.
- _Reporting phase_ (migration `20260914120000_reporting`, additive) — the
  immutable `Report` snapshot table (ADR-0026). See §10.
- _Automation phase_ (migration `20260915120000_automation`, additive) —
  `AutomationRule` + `AutomationRun` (ADR-0027). See §10.
- _Admin & observability phase_ (migration `20260916120000_admin_observability`,
  additive) — the non-tenant `ErrorEvent` and `WorkerHeartbeat` tables
  (ADR-0028). See §10.

---

## 1. Conventions

- **PK:** `id` `String @id @default(cuid())`.
- **Timestamps:** `createdAt DateTime @default(now())`,
  `updatedAt DateTime @updatedAt`. Soft-deletable tables add
  `deletedAt DateTime?` (filtered by a repository default scope).
- **Tenancy:** every tenant-owned table has
  `organizationId String` + `@@index([organizationId])` and an FK with
  `onDelete: Cascade`. Non-tenant tables: `User`, `Account`, `Session`,
  `VerificationToken`, `PlatformStaff`, `BillingEvent`.
- **Naming:** models `PascalCase`, columns `camelCase`, physical tables/cols
  `snake_case` via `@@map` / `@map`.
- **Money:** `Decimal(12, 2)` for currency amounts, `Decimal(14, 6)` for
  fractional cost estimates. Always store `currency` (ISO 4217) alongside.
- **Enums:** Postgres enums for closed sets; a `String` + check for sets likely
  to grow.
- **JSON:** `Json` columns hold **Zod-validated** payloads; the authoritative
  shape lives in `packages/core`, not the DB. Large/append-only blobs go to
  object storage with a pointer row.
- **Time-series:** metric tables are append-only, keyed by
  `(entityId, capturedAt, granularity)`; no in-place updates.

---

## 2. Identity & tenancy

### User _(non-tenant)_

`id, email @unique, emailVerified?, name?, image?, createdAt, updatedAt,
deletedAt?`

- Rel: `memberships Membership[]`, `accounts Account[]`, `sessions Session[]`,
  `profile UserProfile?`, `auditLogs AuditLog[]`.
- Lifecycle: deletion request → anonymize (`email` → tombstone, `name/image`
  nulled) after grace period; memberships removed; owned orgs must be
  transferred or deleted first.

### UserProfile _(1:1 User)_

`userId @unique, timezone, locale, marketingOptIn, createdAt, updatedAt`

### UserPreference

`id, userId, key, value Json, @@unique([userId, key])` — notification and UI
preferences.

### Account / Session / VerificationToken _(Auth.js adapter, non-tenant)_

Standard NextAuth Prisma-adapter shape. `Account` holds **login-provider**
tokens (e.g. Google sign-in) and is distinct from `OAuthConnection` (data
integrations). Access/refresh token columns encrypted at rest.

### Organization

`id, name, slug @unique, type OrgType, createdAt, updatedAt, deletedAt?`

- `OrgType = { PERSONAL, TEAM, AGENCY, BUSINESS }`.
- Rel: `memberships`, `invitations`, `subscription Subscription?`,
  everything tenant-owned.
- Lifecycle: created on signup (`PERSONAL`) or explicitly. Deleting cascades all
  tenant data after a 30-day soft-delete window; audit-logged.

### Membership

`id, userId, organizationId, role Role, status MembershipStatus, invitedById?,
createdAt, updatedAt`

- `Role = { OWNER, ADMIN, MEMBER, VIEWER }`; `MembershipStatus = { ACTIVE,
SUSPENDED }`.
- `@@unique([userId, organizationId])`, `@@index([organizationId, role])`.
- Constraint: each org has ≥ 1 `OWNER` (enforced in service layer + a periodic
  check).

### Invitation

`id, organizationId, email, role, token @unique, expiresAt, acceptedAt?,
revokedAt?, invitedById, createdAt`

- `@@index([organizationId])`, `@@index([email])`. Token is single-use, hashed
  at rest, TTL 7 days.

### PlatformStaff _(non-tenant)_

`id, userId @unique, level StaffLevel, createdAt` — `StaffLevel = { SUPPORT,
OPERATOR, SUPERADMIN }`. Gates `/admin`. Never granted via org roles.

---

## 3. Billing & usage

**Implemented** — migration `20260913120000_billing` (additive). Plan
_definitions_ (prices, per-meter limits, feature flags) live in the config
catalog `packages/services/src/billing/plans.ts`, **not** a `Price` table
(ADR-0025): prices are never hard-coded across the app and never drift between
code paths. Stripe Price IDs are env config (`STRIPE_PRICE_*`).

`BillingTier = { FREE, CREATOR, PRO, AGENCY, ENTERPRISE }` (the roadmap's
`STARTER` was renamed `CREATOR`). `BillingInterval = { MONTH, YEAR }`.

### Subscription _(1:1 Organization)_

`id, organizationId @unique, tier BillingTier @default(FREE), status
SubscriptionStatus @default(ACTIVE), interval BillingInterval, seats Int,
stripeCustomerId? @unique, stripeSubscriptionId? @unique, stripePriceId?,
currentPeriodStart?, currentPeriodEnd?, cancelAtPeriodEnd, canceledAt?,
trialEndsAt?, createdAt, updatedAt`

- `SubscriptionStatus = { TRIALING, ACTIVE, PAST_DUE, CANCELED, INCOMPLETE,
INCOMPLETE_EXPIRED, UNPAID, PAUSED }`. `ACTIVE` / `TRIALING` / `PAST_DUE` keep
  access; the rest gate.
- A FREE org has a row with tier FREE and no Stripe ids. Stripe is the source of
  truth for money; rows are updated by signature-verified webhooks + a nightly
  reconcile job (`billing.reconcileOrganization`).

### Entitlement

`id, organizationId, key, limitValue BigInt?, boolValue Boolean?, source
EntitlementSource @default(PLAN), note?, createdById?, expiresAt?, createdAt,
updatedAt, @@unique([organizationId, key])`

- `key` is `limit:<METER>` (uses `limitValue`, null ⇒ unlimited) or
  `feature:<name>` (uses `boolValue`). `EntitlementSource = { PLAN, OVERRIDE,
PROMO }`.
- PLAN rows are materialised from the catalog for the current tier on every
  plan change; OVERRIDE / PROMO rows are support-granted exceptions and win at
  read time (`resolveEntitlements`). This subsumes the design's separate
  `UsageLimitOverride` table.

### UsageRecord _(append-only ledger)_

`id, organizationId, meter UsageMeter, quantity BigInt, periodStart, actorId?,
subjectType?, subjectId?, costUsd Decimal?, idempotencyKey @unique, metadata
Json?, occurredAt`

- `UsageMeter = { AI_REQUESTS, AI_TOKENS, CRAWLS, CRAWL_PAGES,
CONNECTED_ACCOUNTS, REPORTS, CONTENT_GENERATIONS, SEATS }` (the meters the
  master instruction names, plus `SEATS`).
- `@@index([organizationId, meter, occurredAt])`,
  `@@index([organizationId, meter, periodStart])`. `idempotencyKey` makes a
  double-submit a no-op.

### UsageCounter _(materialized, current period)_

`id, organizationId, meter, periodStart, periodEnd, used BigInt, limitValue
BigInt?, updatedAt, @@unique([organizationId, meter, periodStart])`

- Incremented transactionally with the `UsageRecord` insert on
  `usage.recordUsage`; `usage.checkUsage` reads it. Rebuilt from `UsageRecord`
  by `usage.refreshUsageCounters` (self-healing). Gauge meters (seats, connected
  accounts) are read as a live count instead.

### Invoice _(read-only mirror of Stripe invoices)_

`id, organizationId, stripeInvoiceId @unique, number?, status, amountDue Int,
amountPaid Int, amountRemaining Int, currency, hostedInvoiceUrl?,
invoicePdfUrl?, periodStart?, periodEnd?, issuedAt?, createdAt` — amounts are
integer minor units as Stripe sends them; populated by webhook; **no line-item
or card data ever stored.**

### BillingEvent _(non-tenant — webhook idempotency ledger)_

`id (= the Stripe event id) @id, type, status BillingEventStatus
@default(RECEIVED), payload Json, error?, receivedAt, processedAt?,
@@index([type, receivedAt])` — a redelivered event finds its row and is skipped
before any work (`BillingEventStatus = { RECEIVED, PROCESSED, FAILED, SKIPPED
}`). Non-tenant because some early events (e.g. `customer.created`) cannot be
mapped to an org yet.

---

## 4. Integrations (data connections)

### OAuthConnection

`id, organizationId, provider Provider, externalAccountId, displayName?, scopes
String[], accessTokenEnc, refreshTokenEnc?, expiresAt?, status ConnStatus,
lastRefreshedAt?, createdById, createdAt, updatedAt`

- `Provider = { YOUTUBE, TIKTOK, GOOGLE_SEARCH_CONSOLE }`;
  `ConnStatus = { ACTIVE, EXPIRED, REVOKED, ERROR }`.
- `@@unique([organizationId, provider, externalAccountId])`,
  `@@index([organizationId, provider])`.
- Tokens encrypted with AES-256-GCM (`ENCRYPTION_KEY`); never selected into API
  responses. Disconnect → revoke upstream + set `REVOKED` + null the ciphertext.

### IntegrationHealth

`id, oauthConnectionId @unique, lastCheckAt, ok Boolean, detail?, quotaRemaining
Int?, updatedAt` — written by the health-poll job; surfaced in the Integrations
UI and Admin → API health.

---

## 5. YouTube

### YouTubeChannel

`id, organizationId, oauthConnectionId, channelId, title, handle?, thumbnailUrl?,
uploadsPlaylistId?, country?, firstSyncedAt, lastSyncedAt, @@unique([
organizationId, channelId])`

### YouTubeVideo

`id, organizationId, youTubeChannelId, videoId, title, description, publishedAt,
durationSec, tags String[], categoryId?, thumbnailUrl?, madeForKids?,
lastSyncedAt, @@unique([organizationId, videoId]),
@@index([youTubeChannelId, publishedAt])`

### YouTubeMetric _(append-only time-series)_

`id, organizationId, subjectType YTSubject, subjectId, capturedAt, granularity
Granularity, views, watchTimeMinutes, averageViewDurationSec, impressions?,
impressionsCtr?, likes, comments, shares, subscribersGained, subscribersLost,
estimatedRevenue Decimal?, source, @@unique([subjectType, subjectId, capturedAt,
granularity]), @@index([organizationId, capturedAt])`

- `YTSubject = { CHANNEL, VIDEO }`; `Granularity = { DAY, WEEK, MONTH,
LIFETIME }`. Revenue only present if the connection granted the scope; null
  otherwise (never imputed).

---

## 6. TikTok _(fields depend on granted API scopes)_

### TikTokAccount

`id, organizationId, oauthConnectionId, openId, username, displayName?,
avatarUrl?, followerCount?, followingCount?, likesCount?, firstSyncedAt,
lastSyncedAt, @@unique([organizationId, openId])`

### TikTokVideo

`id, organizationId, tikTokAccountId, videoId, caption?, createTime, durationSec?,
shareUrl?, coverImageUrl?, hashtags String[], lastSyncedAt,
@@unique([organizationId, videoId]), @@index([tikTokAccountId, createTime])`

### TikTokMetric _(append-only)_

`id, organizationId, subjectType TTSubject, subjectId, capturedAt, granularity,
viewCount?, likeCount?, commentCount?, shareCount?, reachCount?, source,
@@unique([subjectType, subjectId, capturedAt, granularity])`

- Nullable everywhere: the official API exposes limited analytics; missing =
  `null`, surfaced in the UI as "not provided by API".

---

## 7. SEO & crawler

### SEOProject

`id, organizationId, name, primaryWebsiteId?, defaultCrawlConfig Json,
createdById, createdAt, updatedAt, deletedAt?`

### Website

`id, organizationId, seoProjectId, rootUrl, host, verified Boolean,
verificationMethod?, verifiedAt?, robotsTxtCache Json?, createdAt, updatedAt,
@@unique([organizationId, host])`

- Crawls beyond a shallow public sample require `verified = true`
  (DNS TXT / HTML file / Search Console). See `SEO-ENGINE.md`.

### Crawl

`id, organizationId, websiteId, status CrawlStatus, config Json (depth, maxPages,
maxDurationSec, renderMode, includePaths, excludePaths, respectRobots), trigger
CrawlTrigger, requestedById?, startedAt?, finishedAt?, pagesFetched, pagesQueued,
bytesFetched, error?, summary Json, @@index([websiteId, createdAt])`

- `CrawlStatus = { QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED, BLOCKED }`;
  `CrawlTrigger = { MANUAL, SCHEDULED, API }`.
- Lifecycle: `QUEUED → RUNNING → COMPLETED|FAILED|CANCELLED`. `BLOCKED` when the
  target refuses the crawler (recorded, never worked around). Raw page bodies →
  object storage; only extracted data in `CrawlPage`.

### CrawlPage

`id, organizationId, crawlId, url, normalizedUrl, httpStatus, finalUrl,
redirectChain Json, depth, contentType?, contentHash?, title?, metaDescription?,
canonicalUrl?, robotsMeta String[], h1 String[], headingOutline Json, wordCount?,
lang?, hreflang Json?, openGraph Json?, twitterCard Json?, structuredData Json?,
imageCount, imagesMissingAlt, internalLinkCount, externalLinkCount, brokenLinks
Json, renderMode RenderMode, jsRendered Boolean, loadTimeMs?, coreWebVitals Json?,
fetchedAt, @@unique([crawlId, normalizedUrl]),
@@index([organizationId, crawlId]), @@index([crawlId, httpStatus])`

- `RenderMode = { STATIC, HEADLESS }`.

### CrawlIssue

`id, organizationId, crawlId, crawlPageId?, code IssueCode, severity Severity,
category IssueCategory, title, detail, evidence Json, affectedUrlCount,
firstSeenCrawlId, status IssueStatus, @@index([crawlId, severity]),
@@index([organizationId, code])`

- `Severity = { CRITICAL, HIGH, MEDIUM, LOW, INFO }`;
  `IssueStatus = { OPEN, ACKNOWLEDGED, FIXED, IGNORED, REGRESSED }`.
- `code` is a stable slug (e.g. `CANONICAL_SITEMAP_CONFLICT`, `REDIRECT_CHAIN`,
  `SOFT_404`, `MIXED_CONTENT`, `ORPHAN_PAGE`, `DUP_TITLE`). Issue identity across
  crawls = `(websiteId, code, normalizedUrl?)` so status/regression carry over.

### SEORecommendation

`id, organizationId, seoProjectId, crawlId?, recommendationId, createdAt`

- Thin join: the explainable content lives in the shared `Recommendation` table
  (§9). This row links SEO context.

---

## 8. Content

### ContentIdea

`id, organizationId, source IdeaSource, platform Platform, title, rationale,
supportingClaims Json, suggestedFormat?, keywords String[], relatedVideoIds
String[], status IdeaStatus, createdByAgentRunId?, createdAt`

- `IdeaSource = { AGENT, USER }`; `Platform = { YOUTUBE, TIKTOK, WEBSITE }`;
  `IdeaStatus = { NEW, SAVED, IN_PROGRESS, PUBLISHED, DISCARDED }`.

---

## 9. AI

### AIConversation

`id, organizationId, userId, title?, context Json (pinned entities, goals),
archived, createdAt, updatedAt, @@index([organizationId, userId])`

### AIMessage

`id, organizationId, conversationId, role MsgRole, content Json (text + tool
parts), tokensPrompt?, tokensCompletion?, model?, provider?, agentRunId?,
createdAt, @@index([conversationId, createdAt])`

- `MsgRole = { USER, ASSISTANT, TOOL, SYSTEM }`. System prompts are referenced
  by id, not stored per message.

### AgentRun

`id, organizationId, conversationId?, agent AgentId, status RunStatus, trigger,
input Json, output Json?, error?, parentRunId?, requestedById?, startedAt?,
finishedAt?, tokensTotal, costEstimate Decimal, createdAt,
@@index([organizationId, agent, createdAt])`

- `RunStatus = { QUEUED, RUNNING, NEEDS_APPROVAL, COMPLETED, FAILED,
CANCELLED }`. `parentRunId` lets the orchestrator model sub-agent calls.

### AgentToolCall

`id, organizationId, agentRunId, toolName, args Json, result Json?, status
ToolCallStatus, approvedById?, approvedAt?, error?, startedAt, finishedAt?,
durationMs?, @@index([agentRunId])`

- `ToolCallStatus = { PENDING, RUNNING, SUCCEEDED, FAILED, REJECTED,
AWAITING_APPROVAL }`. Destructive/external-mutating tools land in
  `AWAITING_APPROVAL` unless automation mode is on.

### AiUsageRecord _(append-only, rolls into UsageRecord)_

`id, organizationId, provider, model, promptTokens, completionTokens,
estimatedCostUsd Decimal(14,6), agentRunId?, context?, createdAt,
@@index([organizationId, createdAt])`

---

## 10. Cross-cutting deliverables

### Recommendation _(shared by SEO, YouTube, TikTok, content, growth)_

`id, organizationId, domain RecDomain, sourceAgentRunId?, title, explanation,
priority Priority, recommendedActions String[], implementationInstructions,
expectedImpact, confidence Float (0..1), effort Effort, evidence Json (Claim[]),
status RecStatus, requiresApproval Boolean @default(true), approvedById?,
approvedAt?, dismissedReason?, taskId?, createdAt, updatedAt,
@@index([organizationId, status]), @@index([organizationId, domain, priority])`

- `RecDomain = { SEO, YOUTUBE, TIKTOK, CONTENT, GROWTH }`;
  `RecStatus = { PROPOSED, APPROVED, REJECTED, APPLIED, DISMISSED }`;
  `Priority = { CRITICAL, HIGH, MEDIUM, LOW }`;
  `Effort = { TRIVIAL, SMALL, MEDIUM, LARGE }`.

### Task

`id, organizationId, title, description?, status TaskStatus, priority, assigneeId?,
recommendationId?, dueAt?, completedAt?, createdById, createdAt, updatedAt,
@@index([organizationId, status])`

- `TaskStatus = { TODO, IN_PROGRESS, BLOCKED, DONE, CANCELLED }`.

### Report

**Implemented** — migration `20260914120000_reporting` (additive).

`id, organizationId, type ReportType, title, status ReportStatus @default(PENDING),
snapshot Json?, params Json @default("{}"), subjectRef?, periodStart?,
periodEnd?, dataThrough?, previousReportId?, generatedByAgentRunId?,
requestedById, error?, shareToken? @unique, shareExpiresAt?, shareRevokedAt?,
shareCreatedById?, createdAt, finishedAt?,
@@index([organizationId, type, createdAt]), @@index([organizationId, createdAt])`

- `ReportType = { YOUTUBE, TIKTOK, SEO, WEBSITE_HEALTH, AI_RECOMMENDATIONS,
GROWTH, MONETIZATION }`; `ReportStatus = { PENDING, BUILDING, READY, FAILED }`.
- `snapshot` is the full **immutable** `ReportSnapshot` (`packages/core`
  `schemas/report.ts`), written once when the report becomes `READY` and never
  changed (ADR-0026). Regenerating creates a new row with `previousReportId` set
  to the prior `READY` report of the same type, which drives the "Historical
  Changes" section.
- Exports (PDF / CSV / JSON) are rendered **on demand** from `snapshot` — there
  is no stored file, no object storage, and no `storageKey`.
- `shareToken` is a 32-byte base64url token for a **public, redacted** view
  (`/r/<token>`); `shareExpiresAt` / `shareRevokedAt` gate it. Private account
  info is never served through the public URL (`redactSnapshotForPublic`).

### AutomationRule / AutomationRun

**Implemented** — migration `20260915120000_automation` (additive). See
`docs/AUTOMATION.md` and ADR-0027.

**`AutomationRule`** — `id, organizationId, ownerId, createdById, taskType
AutomationTaskType, name, cadence AutomationCadence, cronExpression (5-field,
UTC), timezone @default("UTC"), config Json @default("{}"), status
AutomationStatus @default(ACTIVE), maxRetries Int @default(3), lastRunAt?,
lastRunStatus AutomationRunStatus?, nextRunAt?, failureCount Int @default(0)
(consecutive), totalRuns Int @default(0), lastError?, createdAt, updatedAt,
@@index([organizationId, status]), @@index([status, nextRunAt])`

- `AutomationTaskType = { YOUTUBE_ANALYSIS, TIKTOK_ANALYSIS, WEBSITE_CRAWL,
SEO_ISSUE_ALERT, MONETIZATION_SCAN, GROWTH_REPORT, CONTENT_OPPORTUNITY }` — each
  maps to exactly one RBAC `requiredAction`; **none publishes externally**.
- `AutomationCadence = { DAILY, WEEKLY, MONTHLY, CUSTOM }`.
- `AutomationStatus = { ACTIVE, PAUSED, FAILING (5+ consecutive failures),
DISABLED (10+, the sweep skips it) }`.
- `ownerId` is the member every execution runs under; the runner re-checks that
  owner's current role against the task's `requiredAction` (ADR-0027).

**`AutomationRun`** — `id, automationRuleId, organizationId, scheduledFor,
status AutomationRunStatus @default(PENDING), attempt Int @default(1),
triggeredBy @default("schedule"), startedAt?, finishedAt?, durationMs?, output
Json?, error?, nextAttemptAt?, createdAt,
@@unique([automationRuleId, scheduledFor]) (idempotency),
@@index([automationRuleId, createdAt]), @@index([organizationId, createdAt]),
@@index([status, nextAttemptAt])`

- `AutomationRunStatus = { PENDING, RUNNING, SUCCEEDED, FAILED, SKIPPED (owner
lost the permission), RETRY_SCHEDULED, CANCELLED }`.
- The `@@unique([automationRuleId, scheduledFor])` (with `scheduledFor` snapped
  to the rule's `nextRunAt`) makes a double sweep / worker restart a no-op.
- `nextAttemptAt` on a `RETRY_SCHEDULED` run = `now + 60s·2^(attempt-1)` capped
  at 1h; the retry-sweep picks it up.

### Notification

`id, organizationId, userId, type NotifType, title, body, data Json, channel
NotifChannel, readAt?, sentAt?, createdAt, @@index([userId, readAt])`

- `NotifChannel = { IN_APP, EMAIL }`. Delivery respects `UserPreference`.
- _Not yet implemented._ An `SEO_ISSUE_ALERT` automation currently opens a
  `Task` instead of sending a notification.

### AuditLog _(append-only)_

`id, organizationId?, actorId?, actorType ActorType, action, targetType?,
targetId?, ip?, userAgent?, metadata Json, createdAt,
@@index([organizationId, createdAt]), @@index([action, createdAt])`

- `ActorType = { USER, PLATFORM_STAFF, SYSTEM, AGENT }`. No updates or deletes;
  archived to cold storage after 13 months, retained per policy.

### ErrorEvent / WorkerHeartbeat _(non-tenant — admin & observability, Phase 13)_

Migration `20260916120000_admin_observability` (additive). Both tables have **no
`organizationId` FK** — like `BillingEvent`, they must outlive the org they may
mention and are only ever read by platform staff through `/admin`.

**`ErrorEvent`** — a de-duplicated application fault. `id, fingerprint @unique,
source ErrorSource (WEB | WORKER), name, message @db.Text, stack? @db.Text,
route?, method?, statusCode?, correlationId?, organizationId?, actorId?, count
Int @default(1), context Json?, firstSeenAt, lastSeenAt,
@@index([lastSeenAt]), @@index([source, lastSeenAt])`.

- `observability.captureError` computes `fingerprint` = sha1(source + error name
  - first own stack frame + route) and upserts: a repeat of the same fault bumps
    `count` / `lastSeenAt` instead of adding a row.
- `message` and `stack` are run through `scrubSecrets` and capped (1 000 / 4 000
  chars) before they are written — no token material is persisted here.

**`WorkerHeartbeat`** — one row per running worker process. `id, workerId
@unique (hostname:pid), version?, bootAt, lastBeatAt, redisOk Boolean, queues
Json (last queue-depth snapshot), jobsProcessed BigInt, jobsFailed BigInt,
@@index([lastBeatAt])`.

- Refreshed every ~15s. Readers classify staleness: >45s ⇒ degraded, >90s or no
  row ⇒ down. This is how `/api/health` and `/admin` know the worker fleet is
  alive.

---

## 11. Key relationships (summary)

```
Organization 1─* Membership *─1 User
Organization 1─1 Subscription 1─* Invoice
Organization 1─* OAuthConnection 1─* {YouTubeChannel | TikTokAccount}
YouTubeChannel 1─* YouTubeVideo 1─* YouTubeMetric
SEOProject 1─* Website 1─* Crawl 1─* CrawlPage 1─* CrawlIssue
Crawl 1─* SEORecommendation *─1 Recommendation
AIConversation 1─* AIMessage ;  AIConversation 1─* AgentRun 1─* AgentToolCall
AgentRun 1─* Recommendation ;  Recommendation 0..1─1 Task
Organization 1─* {Report, Notification, ContentIdea, AuditLog, UsageRecord}
```

---

## 12. Indexing & performance

- Every FK used in a filter has an index; composite indexes lead with
  `organizationId`.
- Time-series tables: BRIN or partitioning by month on `capturedAt` once volume
  warrants; `(subjectId, capturedAt)` btree for point lookups.
- `CrawlPage` can be large per crawl → partition by `crawlId` hash or move
  cold crawls' pages to a summarized table + object storage after N days.
- Full-text search (recommendations, issues, ideas) via Postgres `tsvector`
  columns + GIN, scoped by `organizationId`.

---

## 13. Data lifecycle & retention

| Data                                   | Retention                           | Notes                          |
| -------------------------------------- | ----------------------------------- | ------------------------------ |
| Raw crawl page bodies (object storage) | 30 days                             | Extracted data kept longer     |
| `CrawlPage` rows                       | per tier history window (7d–12m)    | Older crawls summarized        |
| Metric time-series                     | per tier history window             | Aggregated rollups kept beyond |
| `AIMessage` / `AgentRun`               | 12 months default, org-configurable | Export before purge            |
| `AuditLog`                             | 13 months hot, then cold archive    | Compliance-driven              |
| `UsageRecord`                          | 24 months                           | Billing dispute window         |
| Soft-deleted orgs                      | 30 days then hard delete            | Cascade all tenant data        |
| User deletion request                  | anonymize within 30 days            | Owned orgs handled first       |

---

## 14. Migrations

- Prisma Migrate, all files checked in, reviewed like code.
- `DATABASE_URL` (pooled) for runtime; `DIRECT_URL` (unpooled) for migrate.
- Expand/contract: add nullable → backfill job → enforce not-null →
  drop old in a later release. Never a destructive change in the same deploy
  that starts writing the new shape.
- `prisma migrate deploy` runs in a release step, not at container start.
