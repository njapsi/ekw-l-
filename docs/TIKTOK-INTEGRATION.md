# TIKTOK-INTEGRATION.md

Status: **implemented (Phase 4)**. Official TikTok developer APIs only — no
scraping, no circumvention of API restrictions, no access to private or
unauthorized data.

The content-strategy layer built on top of this integration (benchmarking,
content patterns, an opportunity engine, a content plan, experiments,
anomaly monitoring, and the new agent tools) is documented separately in
`docs/TIKTOK-GROWTH-AGENT.md` (operator's "Phase 7") — this file covers the
OAuth/sync/analyst/publishing foundation only, unchanged by that phase.

## 1. Auth (Login Kit / OAuth 2.0 v2)

- **Endpoints:** authorize at `https://www.tiktok.com/v2/auth/authorize/`, token
  at `https://open.tiktokapis.com/v2/oauth/token/`, revoke at `.../v2/oauth/revoke/`.
- **PKCE (S256) is used.** The connect route generates a `code_verifier`, stores
  it in a **signed, HttpOnly, 10-minute cookie** (`tt_pkce`, HMAC-`AUTH_SECRET`),
  and the callback reads it back for the token exchange. This defends against
  auth-code interception even though we are a confidential client.
- **Signed `state`** (HMAC-`AUTH_SECRET`, 10 min) carries the acting
  `organizationId` + `userId`; the callback attributes the connection from the
  verified state, never a query parameter (CSRF / cross-tenant defense).
- **Scopes (requested minimally):**
  `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`.
  `video.publish` is added **only** when the user chooses "Connect + allow
  publishing". The app records the **granted** scopes and gates every feature on
  them (`user.info.stats` gates follower/like counts; `video.list` gates video
  sync; `video.publish` gates the whole Publishing tab).
- **Redirect URI:** `${APP_URL}/api/integrations/tiktok/callback` (register it in
  the TikTok developer portal).
- **Tokens at rest:** AES-256-GCM envelope (`ENCRYPTION_KEY`), shared
  `OAuthConnection` table. Never selected into an API response or a log line.
- **Refresh:** the generic `withFreshAccessToken` dispatches to the TikTok
  refresher (provider-OAuth registry, ADR-0016). Proactive refresh within 60 s
  of expiry; a live `access_token_invalid` triggers one forced refresh + retry.
  A refresh failure sets `status = ERROR` and shows a "reconnect" prompt.
- **Disconnect:** best-effort upstream revoke, `status = REVOKED`, ciphertext
  scrubbed; synced history kept for reconnect.

## 2. Data sync (Display API v2)

| Call                   | Purpose                                                                                                                                                                                   | Notes                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `POST /v2/user/info/`  | profile + (with `user.info.stats`) follower / following / like / video counts                                                                                                             | one row snapshot into `TikTokMetric` per sync when stats are granted |
| `POST /v2/video/list/` | the user's own video list + per-video fields (`create_time`, `video_description`, `duration`, `cover_image_url`, `share_url`, `like_count`, `comment_count`, `share_count`, `view_count`) | paged with `cursor` (epoch-seconds); `max_count` ≤ 20                |

- **Incremental video sync:** walks pages newest-first, stopping at the stored
  `lastVideoCreateTime` cursor; caps new videos per run (`maxNewVideos`, default
  200); upserts `TikTokVideo` (unique `[organizationId, videoId]`) — no
  duplicates on re-sync. Hashtags are parsed from the caption.
- **Zero videos** returned → the run is `SKIPPED` and the UI says "no new
  videos"; nothing is invented.
- A `REVOKED` connection refuses to sync. Malformed responses → the run is
  `FAILED` and nothing partial is written.
- **A video missing `create_time`** (Phase 26, `docs/DATA-ACCURACY.md`) is
  skipped rather than persisted with a fabricated 1970-01-01 date — a bad
  date would corrupt `postingCadence()`'s gap math and the video list's sort
  order. Counted in the run's skip summary, surfaced in the sync result.

## 3. Failure handling (`tiktok/client.ts`)

TikTok returns HTTP 200 with an `error` object (`error.code === "ok"` on
success). We map:

| `error.code`                                       | Typed error                                          | Behaviour                                                  |
| -------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `access_token_invalid` / `access_token_expired`    | `TikTokAuthExpiredError`                             | refresh + retry once                                       |
| `scope_not_authorized` / `scope_permission_missed` | `TikTokPermissionError` (carries the required scope) | surfaced to the user as "reconnect and approve this scope" |
| `rate_limit_exceeded` / `too_many_requests`        | `TikTokRateLimitError`                               | bounded backoff + retry, then surfaced                     |
| shape mismatch                                     | `TikTokMalformedDataError`                           | run `FAILED`                                               |
| other publish errors (`spam_risk_*`, …)            | `TikTokPublishError`                                 | publish row `FAILED`, error stored, audit-logged           |

## 4. TikTok Analyst Agent (`tiktok/analyst.ts`)

Same discipline as the YouTube analyst (`AI-ARCHITECTURE.md` §6):

- Builds a **fact sheet** (`tiktok/fact-sheet.ts`) of `{id, value, kind, origin}`
  facts: follower/like totals (only if `user.info.stats` granted), per-video view
  distribution, engagement rate, posting cadence, high/low performers, and
  **hashtag theme clusters**. That plus recent video metadata is the only
  quantitative context the model sees.
- Emits the `TikTokAnalysis` schema: `observations`, `recommendations`,
  `contentIdeas`, `captionIdeas`, `hashtagSuggestions`, `contentThemes`,
  `postingRecommendations`, `repurposingRecommendations`, `disclaimers` — every
  item cites `evidenceFactIds`.
- The system prompt requires the model to **clearly separate actual metrics
  (from the fact sheet) from its own ideas/suggestions**, and forbids
  estimating anything the API did not return.
- **Grounding check** (shared `agents/grounding.ts`, reused with YouTube):
  unknown fact ids, ungrounded numbers, and guarantee phrasing (incl. "go
  viral") are rejected → one repair attempt → else the `AgentRun` is `FAILED`
  and nothing is persisted.
- **Thin data** (< 3 videos) → deterministic minimal report, no model call.
- Persists `AgentRun` (tokens + cost), `Recommendation` (`domain = TIKTOK`),
  `ContentIdea` (`platform = TIKTOK`).

## 5. Publishing (Content Posting API)

Only when the connection was granted `video.publish`. Flow (`tiktok/publish.ts`):

1. **Create draft** — content selection (a public **https** direct video URL),
   caption, hashtags, privacy, and comment/duet/stitch toggles. A
   **duplicate-publish guard** rejects an equivalent post (same account + source
   - caption + hashtags) that is already active. Row starts
     `status = AWAITING_APPROVAL`. Audit: `tiktok.publish.drafted`.
2. **Explicit approval** — `approveAndSubmit` requires `approve === true`;
   anything else throws `automation_disabled` ("Explicit approval is required
   before publishing"). The dedupe guard is re-checked to close a race.
   Audit: `tiktok.publish.approved`.
3. **Submit** — `POST /v2/post/publish/video/init/` with
   `source: "PULL_FROM_URL"`. Stores TikTok's `publish_id`, `status = PROCESSING`.
   On any API error → `status = FAILED`, error stored, audit
   `tiktok.publish.failed`, rethrown.
4. **Status** — `POST /v2/post/publish/status/fetch/`.
   `PUBLISH_COMPLETE` → `PUBLISHED`; `FAILED` → `FAILED` with the fail reason.
   Terminal transitions are audit-logged (`tiktok.publish.completed` / `.failed`).

The UI shows a confirmation dialog before submitting. Nothing is ever submitted
without the user clicking **Approve & publish**.

## 6. API limitations (documented — never faked)

- **No day-by-day analytics.** The public API exposes lifetime per-video counts
  and (with `user.info.stats`) account totals — there is no impressions, watch
  time, retention, traffic-source, or time-series data. The Performance and
  Growth views are computed from lifetime video stats and say so; there is no
  fabricated trend line.
- **Follower / like totals need `user.info.stats`.** Without that scope the API
  returns nothing for them; the Overview shows "Not available", never an
  estimate.
- **`video.list` returns only the authenticated user's own public videos.** No
  access to other users, private videos, drafts, or DMs.
- **Publishing:** `PULL_FROM_URL` needs a video URL TikTok can fetch;
  browser/file upload (`FILE_UPLOAD`) is a follow-up. **Public** posts require
  your TikTok app to pass TikTok's audit — unaudited apps can only post
  privately (`SELF_ONLY`), which the privacy selector notes.
- **Analytics that only exist in the TikTok Creator dashboard** (e.g. audience
  demographics, per-post reach breakdowns) are not available via the API and are
  not shown.
