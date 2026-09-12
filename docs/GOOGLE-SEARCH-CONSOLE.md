# GOOGLE-SEARCH-CONSOLE.md

The Google Search Console (GSC) integration — a real implementation against
Google's official **Search Console API v1** (`webmasters/v3` + the URL
Inspection API). It provides OAuth connection + refresh + disconnect, property
discovery / selection / verification status, a search-performance dashboard,
sitemap information, URL-level indexing data, and evidence for the AI SEO Agent.
It never invents a GSC metric: every number shown or reasoned over is captured
from the API into a `SearchConsoleSnapshot` and attributed to Google.

Introduced in the operator's "Phase 20". Resolves FORENSIC-AUDIT **M-5 / INT-3**.

---

## 1. What it needs (credentials, scopes, setup)

| Requirement                                             | Detail                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | **Shared with the YouTube integration** — the same Google Cloud OAuth 2.0 Web client.                                                                                                                                                                                  |
| `ENCRYPTION_KEY`                                        | 32-byte base64 AES-256-GCM key. Required — OAuth tokens are sealed at rest.                                                                                                                                                                                            |
| Enabled Google Cloud APIs                               | **Search Console API** (`searchconsole.googleapis.com`).                                                                                                                                                                                                               |
| OAuth scopes requested                                  | `https://www.googleapis.com/auth/webmasters.readonly` (read-only Search Console) · `openid` · `https://www.googleapis.com/auth/userinfo.email` (to key the connection on the Google account's stable `sub` id). **No write scope.**                                    |
| Authorized redirect URI                                 | `${NEXT_PUBLIC_APP_URL}/api/integrations/google/callback` — **the same URI YouTube already uses.** The callback branches on the signed `state.provider` (`youtube` vs `google_search_console`), so only one redirect URI is registered.                                |
| OAuth consent screen                                    | If the client is still in "Testing", only added test users can connect. The `webmasters.readonly` scope is **not** a Google-classified "sensitive" or "restricted" scope, so no additional Google verification/audit is required beyond publishing the consent screen. |
| Property access in GSC                                  | The connecting Google account must already have a role (Owner / Full / Restricted) on the Search Console property. This integration **cannot verify a property** — do that in Search Console first.                                                                    |

Without the two OAuth env vars + `ENCRYPTION_KEY`, `/app/integrations/search-console`
shows "Not configured" and the connect route redirects with `?error=not_configured`.

---

## 2. OAuth flow, token handling, refresh, disconnect

- **Start** — `GET /api/integrations/search-console/connect`
  (`requirePermission('integration:manage')`, per-user rate limit 15/10min,
  `usage.enforceUsage({ meter: 'CONNECTED_ACCOUNTS' })`) →
  `searchConsole.startSearchConsoleConnect` builds the Google consent URL with an
  **HMAC-signed `state`** (`integrations/state.ts`: org + user + provider,
  10-minute TTL) and `access_type=offline` + `prompt=consent` (guarantees a
  refresh token).
- **Callback** — `GET /api/integrations/google/callback` verifies the state
  (signature + TTL), **binds it to the session** (`state.userId === actingUserId`
  — connection-fixation defence, SECURITY-AUDIT H-1), per-IP rate limit 20/10min,
  then `completeSearchConsoleConnect`: exchanges the code, calls the OpenID
  `userinfo` endpoint for `{ sub, email }`, and `storeConnection({ provider:
'GOOGLE_SEARCH_CONSOLE', externalAccountId: sub, displayName: email })`.
- **Tokens at rest** — `crypto/tokens.ts` `seal`/`open` (AES-256-GCM); the
  connection row stores only ciphertext + `iv` + `authTag` + `keyId`. Tokens are
  **never** selected into an API response, a log line, or the DSR export.
- **Refresh** — every API call goes through `ResilientSearchConsoleClient` →
  `withFreshAccessToken` (`integrations/connections.ts`): refreshes + persists a
  new access token when the current one is within 60s of expiry or the
  connection is `EXPIRED`/`ERROR`. If the API still returns 401, the client
  forces one refresh + retries once, then gives up. An unrecoverable refresh
  failure marks the connection `ERROR` with `lastError` and
  `IntegrationHealth.ok = false`.
- **Disconnect** — `disconnectSearchConsoleAction` → `disconnectConnection`:
  best-effort upstream revoke at `oauth2.googleapis.com/revoke`, then the stored
  ciphertext is scrubbed and status set `REVOKED`. `SearchConsoleSite` /
  `SearchConsoleSnapshot` rows are left (a reconnect re-uses them); an
  organization delete cascades them away.
- **Health** — `IntegrationHealth` records `ok` / `detail` / `quotaUnitsUsedToday`
  after every property sync, performance refresh and URL inspection.

---

## 3. Properties: discovery, selection, verification status

- `syncProperties` calls `sites.list` and upserts one `SearchConsoleSite` per
  returned property. `siteUrl` is the GSC property id — `sc-domain:example.com`
  (a **Domain** property) or `https://example.com/` (a **URL-prefix** property);
  `propertyType` and a registrable `hostname` are derived from it.
- `permissionLevel` (`SITE_OWNER` / `SITE_FULL_USER` / `SITE_RESTRICTED_USER` /
  `SITE_UNVERIFIED_USER`) comes straight from Google. `verified` is
  `permissionLevel !== SITE_UNVERIFIED_USER`. A property Google no longer returns
  is kept but flipped to `verified: false` / `UNKNOWN`.
- An org selects **one active property** (`selectProperty`, `integration:manage`,
  audit-logged). The dashboard and the SEO agent use the selected property.
- The `hostname` is what the SEO agent matches against a crawled `Website` — a
  crawl of `blog.example.com` combines with a `sc-domain:example.com` property.

---

## 4. What the API exposes — and what it does not

| Data                                  | API                                                | Notes / limits                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search performance**                | `searchanalytics.query`                            | Queried once per dimension (`date`, `query`, `page`, `country`, `device`, `searchAppearance`), 250 rows max for query/page. **~2–3 day reporting lag** — we query `[today-2d-N, today-2d]` with `dataState: 'final'`. GSC keeps **16 months** of history.                                                                     |
| **Search appearance**                 | `searchanalytics.query` dim `searchAppearance`     | Only populated when the property earns special result types (rich results, AMP, video, …). The UI shows an explainer when empty.                                                                                                                                                                                              |
| **Sitemaps**                          | `sitemaps.list`                                    | Submitted sitemaps + per-type **submitted vs indexed** counts + warnings / errors + last-downloaded.                                                                                                                                                                                                                          |
| **Indexing status (per URL)**         | URL Inspection API (`urlInspection/index:inspect`) | **One URL per call.** Verdict, `coverageState`, `robotsTxtState`, `indexingState`, `lastCrawlTime`, Google vs user canonical, referring URLs, mobile-usability + rich-results verdicts. Quota ≈ **2,000 inspections/day per property**, 600/min — so it is **on-demand only**, never bulk, and rate-limited per org (30/min). |
| **Bulk index coverage**               | —                                                  | **Google exposes no bulk index-coverage export via any API.** The "Indexing" tab therefore shows the sitemap submitted/indexed aggregate + the per-URL inspection tool, and says so.                                                                                                                                          |
| **Core Web Vitals / page experience** | —                                                  | Not in the Search Console API. (The CrUX API is separate and out of scope.)                                                                                                                                                                                                                                                   |

### Failure behaviour

`google-client.ts` maps: 401 → `ScAuthExpiredError` (triggers a refresh + one
retry); 403 with a quota reason → `ScQuotaExceededError` (back off); other 403 →
`ScPermissionError` ("the connected account has no access to this property");
404 → `ScPropertyNotFoundError`; a schema mismatch → `ScMalformedDataError`; 5xx
is retried with jittered backoff (3 attempts). Every failure sets
`IntegrationHealth.ok = false` with a reason and surfaces a clear UI message.

---

## 5. Storage model

- `SearchConsoleSite` — the durable record of a discovered property (selection +
  verification status + last-sync timestamps). Reused across reconnects.
- `SearchConsoleSnapshot` — a point-in-time capture of API output. `kind`:
  - `PERFORMANCE` — `{ totals, byDate, byQuery, byPage, byCountry, byDevice, bySearchAppearance, rangeDays }`, each row `{ keys, clicks, impressions, ctr, position }` (Google's own per-row values). `totals.ctr`/`totals.position` are **our own impression-weighted aggregate** of `byDate` and are `null` (Phase 26, `docs/DATA-ACCURACY.md`) — not `0` — when the window has zero impressions, since Google never reports a real position of `0`.
  - `SITEMAPS` — the `sitemaps.list` result, normalised.
  - `URL_INSPECTION` — one per inspected URL (`subjectUrl`), latest wins.
- The dashboard reads the **latest** `PERFORMANCE` + `SITEMAPS` snapshot; the SEO
  agent reads the latest `PERFORMANCE` snapshot for the matching property. A
  "Refresh data" button (rate-limited 10/min/org) captures a new snapshot; a
  `search-console-sync` BullMQ queue exists for scheduled / offloaded refresh.
- Zod schemas in `searchconsole/schemas.ts` validate both the raw API responses
  and the persisted `data` shapes — nothing is trusted raw.

---

## 6. The SEO Agent: combining crawler + Search Console

When a verified, selected GSC property's `hostname` matches the crawled site, the
agent (`seo/agent.ts` → `gatherSearchConsole`) adds a `searchConsole` block to
its report and computes **three deterministic correlations** (`searchconsole/correlate.ts`):

1. **Crawl issue affecting a page that receives impressions** — a HIGH/CRITICAL
   `CrawlIssue` on a URL that GSC reports ≥ 10 impressions for.
2. **Page receives impressions but has poor click-through rate** — a page with
   ≥ 25 impressions whose CTR is below half the window's median (floored at 1%),
   annotated with the crawl's title / meta-description state for that URL.
3. **Important pages exist in the sitemap but have weak internal linking** — a
   URL discovered via the sitemap that GSC shows impressions for and the crawl
   found fewer than 3 internal links pointing to.

Every correlation carries three explicitly labelled fields:

- `crawlerEvidence` — what our technical crawl found.
- `searchConsoleEvidence` — Google's own reported figures for that URL/window.
- `interpretation` — our fixed, deterministic reading (no ranking prediction).

The optional model narrative (`searchConsoleNote`) must label every sentence
`Crawler evidence:` / `Search Console evidence:` / `AI interpretation:` and is
**grounding-checked** — every GSC number it states must appear in the fact sheet
(`gsc_total_clicks`, `gsc_total_impressions`, `gsc_avg_ctr_pct`,
`gsc_avg_position`, `gsc_pages_with_impressions`, `gsc_top_query_*`, `gsc_corr_*`).
If it cannot be grounded it is dropped; the deterministic `searchConsole` block
(numbers + correlations) is unaffected. With no matching property the block is
`{ connected: false, reason }` and the agent states it used crawler data only.

The GSC agent tools (`searchconsole/agent-tools.ts` — `gsc.get_property`,
`gsc.get_performance`, `gsc.get_top_queries`, `gsc.get_top_pages`,
`gsc.get_sitemaps`, `gsc.inspect_url`) are **read-only**, org-scoped from the
tenant context, and return `{ available: false, reason }` rather than throwing
or fabricating when there is no property / no snapshot.

---

## 7. Security properties

- **OAuth state** — HMAC-signed, 10-min TTL, carries org + user + provider; the
  callback is additionally bound to the session that started it.
- **Tokens** — AES-256-GCM at rest, `keyId` recorded, never logged, never
  returned to the browser, never in the DSR export. The Google client id is only
  used server-side to build the consent URL.
- **Tenant isolation** — every `SearchConsoleSite` / `SearchConsoleSnapshot`
  read and write filters by `organizationId`; `selectProperty` / `refresh*` /
  `inspectUrl` resolve the property with an org check first (`requireProperty`).
  `scripts/check-tenant-scope.mjs` covers the new models; the cross-tenant
  integration test seeds a property for org A and asserts org B cannot read or
  select it.
- **Authorization** — `integration:manage` for connect / disconnect / select /
  refresh / inspect; `data:read` for the dashboard view.
- **Rate limiting** — connect 15/10min per user; callback 20/10min per IP;
  performance refresh 10/min per org; URL inspection 30/min per org.
- **Quota** — `IntegrationHealth.quotaUnitsUsedToday` is incremented per API
  call; URL Inspection is on-demand only.

---

## 8. Where things live

| Concern                                         | File(s)                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| OAuth scopes + provider registration + userinfo | `packages/services/src/integrations/google.ts`                                                           |
| Typed API client + errors                       | `searchconsole/client.ts`, `searchconsole/google-client.ts`                                              |
| Response + snapshot schemas                     | `searchconsole/schemas.ts`                                                                               |
| Token-refreshing wrapper                        | `searchconsole/resilient-client.ts`                                                                      |
| Connect / callback logic                        | `searchconsole/connect.ts`                                                                               |
| Property discovery / selection                  | `searchconsole/sites.ts`                                                                                 |
| Snapshots + dashboard + agent seam              | `searchconsole/read.ts`                                                                                  |
| Deterministic crawler×GSC correlations          | `searchconsole/correlate.ts`                                                                             |
| SEO-agent GSC tools                             | `searchconsole/agent-tools.ts`                                                                           |
| Worker queue                                    | `apps/worker/src/processors/search-console.ts`                                                           |
| OAuth start route                               | `apps/web/app/api/integrations/search-console/connect/route.ts`                                          |
| Shared Google callback (provider-aware)         | `apps/web/app/api/integrations/google/callback/route.ts`                                                 |
| Server actions                                  | `apps/web/src/server/search-console-actions.ts`                                                          |
| Dashboard                                       | `apps/web/app/(app)/app/seo/search-console/page.tsx` + `components/app/seo/search-console-dashboard.tsx` |
| Integration management page                     | `apps/web/app/(app)/app/integrations/search-console/page.tsx`                                            |
| Schema                                          | `packages/db/prisma/schema.prisma` (migration `20260918120000_search_console`)                           |

---

## 9. Do not claim this "works" without

A real Google Cloud OAuth client with the Search Console API enabled, a
published consent screen (or the connecting user added as a test user), and a
Search Console property the connecting account already has a role on. Until
then the integration is fully implemented but **externally-configuration-gated**.
