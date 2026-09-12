# YOUTUBE-INTEGRATION.md

Status: **implemented (Phase 3)**. Official Google APIs only — no scraping.

## 1. Auth

Google OAuth 2.0, Authorization Code flow.

- **Scopes (read-only, minimal):**
  `https://www.googleapis.com/auth/youtube.readonly` and
  `https://www.googleapis.com/auth/yt-analytics.readonly`. The monetary scope
  `yt-analytics-monetary.readonly` is added **only** when the user explicitly
  chooses "Connect + include revenue".
- **Redirect URI:** `${APP_URL}/api/integrations/google/callback` (register it in
  Google Cloud). The provider-generic callback path is deliberate.
- **State:** a signed (HMAC-SHA256 with `AUTH_SECRET`), 10-minute `state` token
  carries the acting `organizationId` + `userId`. The callback attributes the
  connection from the **verified state**, never a query parameter — this is the
  CSRF / cross-tenant defense (`integrations/state.ts`, tested).
- **`access_type=offline` + `prompt=consent`** so a refresh token is returned.
- **Tokens at rest:** AES-256-GCM envelope (`ENCRYPTION_KEY`, 32 bytes), stored
  in `OAuthConnection.{accessTokenCipher,refreshTokenCipher,tokenIv,tokenAuthTag,
keyId}`. Never selected into an API response or a log line
  (`crypto/tokens.ts`, `SECURITY.md` §5).
- **Refresh:** `withFreshAccessToken` refreshes proactively when the token is
  within 60 s of expiry (or already `EXPIRED`/`ERROR`); the API client also
  forces one refresh + retry on a live 401. A refresh failure sets
  `status = ERROR` + `lastError` and surfaces a "reconnect" prompt — it never
  silently fails.
- **Disconnect:** revokes the token upstream (best-effort), sets
  `status = REVOKED`, and scrubs all ciphertext columns. Synced history
  (channels, videos, metrics) is **kept** so a reconnect keeps trends.
- **Connection health:** `IntegrationHealth` records ok/detail, `lastCheckAt`,
  and `quotaUnitsUsedToday` (with a daily rollover).

## 2. APIs used

| API              | Calls                                                                         | Quota (units)               |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------- |
| Data API v3      | `channels.list` (mine / by id), `playlistItems.list` (uploads), `videos.list` | 1 each                      |
| Analytics API v2 | `reports` query, `dimensions=day`                                             | 1 (separately rate-limited) |

No search, no comments API, no write endpoints.

## 3. Sync engine (`youtube/sync.ts`)

All sync steps: check the per-connection quota slice **before** the call
(`quota.ts` `assertQuota`), record spend into `IntegrationHealth` **after**, and
write a `YouTubeSyncRun` row (`RUNNING → COMPLETED | FAILED | SKIPPED`, with
`itemsProcessed`, `quotaUnitsSpent`, `cursor`, `error`).

1. **Channel discovery** — `channels.list?mine=true` → upsert `YouTubeChannel`
   (unique `[organizationId, channelId]`), capture `uploadsPlaylistId` and
   public statistics. `hiddenSubscriberCount` channels store `null` subscribers,
   never 0.
2. **Channel sync** — refresh public statistics (1 unit).
3. **Video sync (incremental)** — walk the uploads playlist newest-first,
   stopping at the `lastVideoPublishedAt` cursor; cap new videos per run
   (`maxNewVideos`, default 200); also refresh lifetime stats for the N most
   recent stored videos (`refreshRecentCount`, default 30). `videos.list` in
   batches of 50. Upsert `YouTubeVideo` (unique `[organizationId, videoId]`) —
   no duplicates on re-sync. Advances the cursor.
4. **Analytics sync (incremental)** — daily `views, estimatedMinutesWatched,
averageViewDuration, likes, comments, shares, subscribersGained,
subscribersLost` for the channel. `estimatedRevenue` **only** if the monetary
   scope was granted. Date window: `lastAnalyticsSyncAt - 3d` (overlap for
   late-arriving data) to `today - 2d` (reporting lag). Upsert `YouTubeMetric`
   (unique `[subjectType, subjectId, date]`). **Zero rows is not an error** — it
   is recorded as `SKIPPED` and surfaced in the UI as "analytics unavailable for
   this range", never estimated. **A successful response missing one of the
   8 requested metric columns is treated as malformed** (Phase 26,
   `docs/DATA-ACCURACY.md`) — `syncAnalytics` throws `MalformedApiDataError`
   before writing any row rather than silently zero-filling the missing
   metric for every day; `estimatedRevenue`'s absence stays legitimate
   (a non-monetized channel has no revenue column even when requested) and
   is excluded from this check.

**Failure handling (`youtube/client.ts`):** 401 → `AuthExpiredError` (→ refresh

- retry once); 403 `quotaExceeded`/`rateLimitExceeded`/… → `QuotaExceededError`;
  5xx → capped jittered-backoff retry then `YouTubeApiError`; a response that does
  not match the Zod schema → `MalformedApiDataError` (the run is marked `FAILED`,
  nothing partial is written). A `REVOKED` connection refuses to sync.

**Execution:** the "Sync now" buttons run a bounded sync **inline** in a Server
Action (one channel ≈ 5–15 API calls, seconds). The same
`youtube.runYouTube*` functions are also registered on the `youtube-sync`
BullMQ queue (`apps/worker`) for when channel volume needs offloading
(`DECISIONS.md` ADR-0013).

## 4. YouTube Analyst Agent (`youtube/analyst.ts`)

- Aggregates a **fact sheet** (`fact-sheet.ts`): channel stats, per-video view
  distribution, engagement rate, publishing cadence, high/low performers, topic
  clusters, and (when present) 28-/365-day analytics windows and deltas. Each
  fact has a stable `id`, a `kind` (`fact` vs `calculated_metric`), and an
  `origin`.
- The model receives **only** the fact sheet + recent video metadata, and must
  emit the `YouTubeAnalysis` schema: `findings` (opportunity | warning |
  observation), `recommendations`, `titleSuggestions`,
  `descriptionSuggestions`, `topicSuggestions`, `publishingRecommendations`,
  `contentIdeas`, `disclaimers`. Every analytical item carries
  `evidenceFactIds`, and recommendations carry reasoning, suggestedAction,
  expectedImpact, confidence, effort, and priority.
- **Grounding check (`grounding.ts`)** — before anything is persisted:
  1. every `evidenceFactIds` entry must resolve to a fact in the sheet;
  2. every number in free text must match a fact value (±2 %) or be an
     obviously-safe number (small integer / year / 0–100 %);
  3. no guarantee-style phrasing (`guarantee`, "you will be monetized", …).
     On failure the agent gets **one** repair attempt with the specific issues;
     if it still fails, the `AgentRun` is marked `FAILED`, an audit event is
     written, and `AgentGroundingError` is thrown — ungrounded content is never
     shown.
- **Thin data** (< 3 videos synced): the agent returns a deterministic minimal
  report with disclaimers and **makes no model call**.
- Output persists as `AgentRun` (tokens + cost + model + provider),
  `Recommendation` rows (`domain = YOUTUBE`, `evidence` = the cited facts as
  `Claim`s), and `ContentIdea` rows.

## 5. Dashboard (`/app/youtube/*`)

Tabs: **Overview**, **Performance**, **Videos**, **Growth**, **Content
opportunities**, **Monetization**, **Recommendations**. Every page reads
org-scoped data via `youtube/read.ts`; when not configured / not connected /
not synced it shows a clear empty state ("Connect YouTube to begin analyzing
your channel.") — **no sample or fabricated data**.

## 6. Monetization page (`youtube/monetization.ts`)

Four explicitly separated sections:

1. **Official requirements** — the YouTube Partner Program criteria as `fact`s,
   each with a source.
2. **What our synced data shows** — subscriber count and a 365-day watch-hour
   estimate as `calculated_metric`s, plus explicit **unavailable** entries
   (policy/strike status, YPP review decision, public-vs-total watch-hour split)
   each with a `howToVerify` pointer to YouTube Studio.
3. **Your attestations** — items only the user can confirm (2SV, no strikes,
   AdSense linked, region), stored as `assumption`s.
4. **Readiness estimate** — a `prediction` with a confidence score derived from
   1–3, listing met / unmet / unverifiable thresholds.

`NEVER_GUARANTEE_NOTICE` is shown on the page and asserted in tests. The code
and copy never say monetization or revenue is guaranteed.

## 7. Documented limitations (not faked)

- The API does not expose _valid public_ watch hours separately from total
  watch time; our estimate is labelled and the user is pointed to Studio.
- Policy-review status, Community Guidelines strikes, and the YPP decision are
  never available via the API.
- Small/new channels frequently return **no** analytics rows for a window —
  reported as unavailable, never interpolated.
- `hiddenSubscriberCount` channels: subscriber count is `null`, not `0`.
- Per-video analytics (retention curves, traffic sources, impressions/CTR) are
  a follow-up — Phase 3 syncs channel-level daily analytics to bound quota.
