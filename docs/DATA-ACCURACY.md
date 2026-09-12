# DATA-ACCURACY.md

Phase 26 — a traceability audit of every displayed metric: for each one,
**Source → API field → DB field → Calculation/Transformation → Display**,
verified against the running code (not just read), with hand-computed test
fixtures compared against the application's own output. Six metric families
were traced end to end: YouTube, TikTok, Google Search Console, the SEO
crawler, revenue tracking, and growth-percentage / historical-comparison
math shared by the reporting engine.

**Eight findings, all fixed this phase** (six were "missing/estimated
mislabeled as a real zero," plus two genuine test-coverage gaps — one of
which surfaced a live, previously-undetected calculation bug the moment a
hand-computed value was checked against it). Everything else traced below
was already correct and is now pinned by a test rather than left to
re-reading the code.

Full design reference: `docs/YOUTUBE-INTEGRATION.md`,
`docs/TIKTOK-INTEGRATION.md`, `docs/GOOGLE-SEARCH-CONSOLE.md`,
`docs/SEO-ENGINE.md`, `docs/MONETIZATION.md`, `docs/REPORTING.md`. Decision
record: `docs/DECISIONS.md` ADR-0041.

---

## 1. YouTube metrics

| #   | Metric                                 | Source                                              | API field                                                                                                                                                         | DB field                                                | Calculation                                                          | Display                                                                   |
| --- | -------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Subscriber/view/video counts           | Data API v3 `channels.list`                         | `statistics.{subscriberCount,viewCount,videoCount}`                                                                                                               | `YouTubeChannel.{subscriberCount,viewCount,videoCount}` | pass-through                                                         | `/app/youtube/overview`                                                   |
| 2   | Hidden subscriber count                | Data API v3                                         | `statistics.hiddenSubscriberCount`                                                                                                                                | `YouTubeChannel.hiddenSubscriberCount`                  | pass-through                                                         | shown as **"Hidden"**, never `0` (`overview/page.tsx`)                    |
| 3   | Daily views/watch time/likes/etc.      | Analytics API v2 `reports.query` (`dimensions=day`) | `columnHeaders`/`rows` for `views, estimatedMinutesWatched, averageViewDuration, likes, comments, shares, subscribersGained, subscribersLost[, estimatedRevenue]` | `YouTubeMetric` (one row per day)                       | pass-through, `BigInt(Math.round(...))`                              | `/app/youtube/growth` sparklines, `/app/youtube/performance` window stats |
| 4   | Engagement rate                        | derived                                             | —                                                                                                                                                                 | —                                                       | `(likes+comments)/views`, `engagementRate()` (`youtube/metrics.ts`)  | analyst fact sheet                                                        |
| 5   | High/low performers, median/mean views | derived                                             | —                                                                                                                                                                 | —                                                       | `performerSplit()` — median-relative classification, needs ≥5 videos | `/app/youtube/performance`                                                |
| 6   | Publishing cadence                     | derived                                             | —                                                                                                                                                                 | —                                                       | `publishingCadence()` — per-week rate + gap days                     | `/app/youtube/performance`                                                |
| 7   | Window totals (28d/365d)               | derived                                             | —                                                                                                                                                                 | —                                                       | `windowTotals()` — sums a trailing window                            | `/app/youtube/performance`, `/app/youtube/growth`                         |
| 8   | Growth % (views/watch-hours)           | derived                                             | —                                                                                                                                                                 | —                                                       | `growthDelta()` — `(a-b)/b*100`, `null` if `b===0`                   | analyst fact sheet only (not a raw dashboard stat — see §6)               |
| 9   | Net subscribers (28d)                  | derived                                             | —                                                                                                                                                                 | —                                                       | `gained - lost` inside `windowTotals()`                              | `/app/youtube/growth`, `/app/youtube/performance`                         |

**Verification:**

- _Missing vs. zero:_ a day with no `YouTubeMetric` row (API returned no
  rows, or "SKIPPED") is absent from `windowTotals`' input — reported as
  "analytics unavailable for this range," never a zero day. `hiddenSubscriberCount`
  channels store `null` subscribers, displayed as "Hidden."
- _API error vs. zero (Finding 1, fixed):_ `google-client.ts` throws typed
  errors (`AuthExpiredError`/`QuotaExceededError`/`YouTubeApiError`) on
  4xx/5xx, and `sync.ts` marks the run `FAILED` and writes nothing on those —
  confirmed correct. But a **successful** response missing one of the 8
  requested metric columns previously fell through to a silent `0` for every
  row (`sync.ts`'s `num()` helper, unguarded). Fixed: `syncAnalytics` now
  verifies every requested `CHANNEL_METRICS` column exists in
  `data.columnHeaders` before writing anything, throwing
  `MalformedApiDataError` (marking the run `FAILED`, nothing partial written)
  if not — matching the contract the module already documented for a
  schema-invalid response. `estimatedRevenue`'s already-correct
  absence-means-`null` handling (a non-monetized channel legitimately has no
  revenue column) is untouched and explicitly excluded from the new check.
  Test: `youtube/sync.test.ts`.
- _Estimated/labeled:_ `estimatedRevenue` is labeled "Estimated by YouTube;
  not a guarantee of payout" wherever shown. `growthDelta()`'s output is
  tagged `kind: 'calculated_metric'` in the analyst fact sheet and never
  rendered as a raw dashboard number (see §6).
- _Dead stub (Finding 3, fixed):_ `/app/youtube/performance`'s "Net subs
  (28d)" stat was hardcoded to `pct(null)` — always "—" — even though
  `o.windows.last28d.netSubscribers` was already computed and used on the
  Growth page. Wired to `fullNumber(o.windows.last28d?.netSubscribers ?? null)`.
- _Reproducible:_ `engagementRate`, `windowTotals`, `growthDelta` are pure
  functions. `metrics.test.ts` now has an exact hand-computed `growthDelta`
  case (150 vs. 100 views → **+50%** exactly; 20 vs. 10 watch hours →
  **+100%**; net-subs delta **+20** — `(150-100)/100*100`, `(20-10)/10*100`)
  in addition to the existing `engagementRate`/`windowTotals` exact cases.

## 2. TikTok metrics

| #   | Metric                                   | Source                      | API field                     | DB field                 | Calculation                                                               | Display                           |
| --- | ---------------------------------------- | --------------------------- | ----------------------------- | ------------------------ | ------------------------------------------------------------------------- | --------------------------------- |
| 1   | Follower/following/like/video counts     | Display API v2 `user/info`  | `follower_count`, etc.        | `TikTokAccount.*`        | pass-through, only when `user.info.stats` scope granted                   | `/app/tiktok/overview`            |
| 2   | Per-video view/like/comment/share counts | Display API v2 `video/list` | `view_count`, etc.            | `TikTokVideo.*`          | pass-through                                                              | `/app/tiktok/videos`              |
| 3   | Video create time                        | Display API v2 `video/list` | `create_time` (epoch seconds) | `TikTokVideo.createTime` | `new Date(create_time * 1000)`                                            | video list ordering, cadence math |
| 4   | Engagement rate                          | derived                     | —                             | —                        | `(likes+comments+shares)/views`, `engagementRate()` (`tiktok/metrics.ts`) | `/app/tiktok/performance`         |
| 5   | Posting cadence                          | derived                     | —                             | —                        | `postingCadence()` — per-week rate + gap days                             | `/app/tiktok/performance`         |
| 6   | High/low performers                      | derived                     | —                             | —                        | `performerSplit()` — median-relative, needs ≥5 videos                     | `/app/tiktok/performance`         |
| 7   | Theme clusters                           | derived                     | —                             | —                        | `themeClusters()` — group by shared hashtag (≥2 videos), ranked by views  | `/app/tiktok/recommendations`     |

**TikTok has no day-by-day analytics API access** (documented,
`tiktok/metrics.ts`'s own header comment) — there is deliberately **no**
growth-percentage or trend page for TikTok anywhere in the app, confirmed by
inspecting every `/app/tiktok/*` page; nothing implies a trend that doesn't
exist.

**Verification:**

- _Missing vs. zero (Finding 2, fixed):_ `create_time` is modeled as
  optional in our own Zod schema (`schemas.ts`) — a response missing it
  passed validation and reached `new Date((v.create_time ?? 0) * 1000)`,
  writing a real, persisted 1970-01-01 `createTime` that would corrupt
  `postingCadence()`'s gap math (a ~56-year fake gap) and the video list's
  sort order. `createTime` is a required, non-null column (no migration this
  phase), so the fix **skips persisting that one video** — logged and
  counted in the run's skip summary — rather than inventing a date. Test:
  `tiktok/sync.test.ts`.
- _API error vs. zero:_ `client.ts` maps every documented TikTok
  `error.code` to a typed error (`TikTokAuthExpiredError`,
  `TikTokRateLimitError`, `TikTokMalformedDataError`) and the video-sync run
  is marked `FAILED` on a shape mismatch — confirmed, no zero-fill path.
- _Reproducible / hand-verified (Finding 6):_ **`tiktok/metrics.ts` had zero
  test coverage before this phase** (its YouTube counterpart already had
  hand-computed tests). New `tiktok/metrics.test.ts` covers all four
  functions with exact hand-computed values, e.g. `engagementRate` = `(60
likes + 30 comments + 10 shares) / 1000 views = 0.1` exactly; a
  six-video `performerSplit` where the median (average of the two middle
  sorted values, 30 and 40) is exactly **35**, so only the 300-view video
  clears the 1.5× high-performer bar and only the 10-view video falls under
  the 0.5× low-performer bar.

## 3. Google Search Console metrics

| #   | Metric                                  | Source                  | API field                                  | DB field                                                           | Calculation                                                                                              | Display                              |
| --- | --------------------------------------- | ----------------------- | ------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | Per-row clicks/impressions/CTR/position | `searchanalytics.query` | `rows[].{clicks,impressions,ctr,position}` | `SearchConsoleSnapshot.data.byDate/byQuery/byPage/...` (`PerfRow`) | pass-through — Google computes CTR/position per row                                                      | Queries/Pages/Countries/Devices tabs |
| 2   | Aggregate totals (clicks, impressions)  | derived from `byDate`   | —                                          | `.totals.{clicks,impressions}`                                     | `sum(byDate[].clicks/impressions)`                                                                       | dashboard stat cards                 |
| 3   | Aggregate avg. CTR                      | derived                 | —                                          | `.totals.ctr`                                                      | `clicks / impressions` (impression-weighted by construction)                                             | dashboard "Avg CTR"                  |
| 4   | Aggregate avg. position                 | derived                 | —                                          | `.totals.position`                                                 | `Σ(position×impressions) / Σimpressions` — impression-weighted average, the standard/correct methodology | dashboard "Avg position"             |
| 5   | Sitemap submitted/indexed counts        | `sitemaps.list`         | `contents[].{submitted,indexed}`           | `SearchConsoleSnapshot.data` (SITEMAPS)                            | pass-through                                                                                             | Sitemaps tab                         |
| 6   | URL indexing verdict                    | URL Inspection API      | `indexStatusResult.*`                      | `SearchConsoleSnapshot` (URL_INSPECTION)                           | pass-through                                                                                             | on-demand inspection panel           |

**Verification:**

- _Missing vs. zero (Finding 4, fixed):_ per-row `ctr`/`position` are
  Google's own values (untouched, correct). The **aggregate** `totals.ctr`/
  `totals.position` — computed by our own code — defaulted to `0` when
  `impressions === 0`. Google never reports a real position of `0`
  (positions start at 1); a `0` here can only mean "nothing to average," but
  the dashboard rendered it as "Avg position 0.0" / "Avg CTR 0.0%," reading
  as a real measurement. Fixed: `PerformanceSnapshotData.totals.{ctr,position}`
  are now `number | null` (Zod + the `refreshPerformance` computation);
  `null` on zero impressions; the dashboard (`search-console-dashboard.tsx`
  and the per-website `SEO` page's Search Console card) shows "—" for the
  null case. The SEO agent's fact sheet (`seo/agent.ts`) now **omits** the
  `gsc_avg_ctr_pct`/`gsc_avg_position` facts entirely when null, rather than
  ever letting the model see or cite a fabricated `0`.
- _API error vs. zero:_ `refreshPerformance` wraps the whole multi-dimension
  fetch in one `try`; any dimension's failure aborts the entire snapshot
  (`recordHealth(false)` + rethrow) — **no snapshot is persisted on a partial
  failure**, confirmed by `read.test.ts`'s "surfaces an API failure and
  writes no snapshot" case.
- _Reproducible:_ new `read.test.ts` cases hand-verify the impression-weighted
  aggregate math (`10 clicks / 200 impressions = 0.05` CTR exactly; `(7 ×

200. / 200 = 7` position exactly for a single-day window) and the new
     null-on-zero-impressions behavior.

## 4. SEO crawler metrics

| #   | Metric                             | Source                      | Calculation                                                                            | Display                           |
| --- | ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | Per-category score (0-100)         | our own crawl + rule engine | `scoreCrawl()` — severity-weighted, reach-scaled deductions from 100 (`scoring.ts`)    | crawl overview cards              |
| 2   | Overall score + grade              | derived                     | published `CATEGORY_WEIGHTS` (sum to 1) weighted average, then `gradeFor()` thresholds | crawl overview                    |
| 3   | AI-readability signals (0-100 ×9)  | derived                     | `ai-readability.ts`, each signal a deterministic percentage/boolean rollup             | AI SEO Agent report               |
| 4   | `priorityScore` per recommendation | derived                     | `recommendation-engine.ts` — six published weighted factors                            | recommendation list, action plans |

**Verification:**

- _Reproducible (Finding 7a, fixed):_ `scoreCrawl` was tested only
  relationally (`toBeLessThan`/`toBeGreaterThan`). Added a fully hand-computed
  case: one `CRITICAL` `crawlability` issue affecting 50/50 pages —
  `affectedFraction = min(1, 50/50) = 1`, `scale = 0.4 + 0.6×√1 = 1.0`,
  `penalty = 40 × 1.0 × 1 = 40`, category score `= round(100-40) = 60`,
  overall `= round(60×0.18 + 100×0.82) = round(92.8) = 93` — asserted exactly,
  matching what a reviewer computes by hand from the published weights.
- _Missing vs. zero:_ `ai-readability.ts`'s shared `pct(n, d)` helper returns
  `100` (a perfect score) when `d === 0`, rather than a "no data" value —
  every current call site guards the denominator with `Math.max(1, denom)`
  so this branch is unreachable today (confirmed by tracing every call
  site). **Documented as a latent trap, not fixed** — there is no live bug
  to fix, and guarding an unreachable branch defensively would touch code
  with no failing case to pin a regression test against.
- _Never a ranking prediction:_ `scoreCrawl`'s own `note` field and
  `recommendation-engine.ts`'s header comment both state the score is
  diagnostic, not a ranking prediction — confirmed unchanged.

## 5. Revenue calculations

| #   | Metric                                    | Source                                      | Calculation                                                                                         | Display                                          |
| --- | ----------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Total by currency / by channel / by month | 100% user-entered `RevenueEntry` rows       | `getRevenueSummary()` — plain sums, `byMonth` keyed by `periodStart.toISOString().slice(0,7)` (UTC) | Revenue tracker                                  |
| 2   | Recurring monthly estimate                | derived from user-entered recurring entries | spread each entry's amount across the calendar months it covers                                     | Revenue tracker, labeled "Estimated recurring ≈" |

**Verification:**

- _Reproducible, and a real bug found by hand-verifying it (Finding 7b/8,
  fixed):_ `recurringMonthlyByCurrency` had **zero test coverage** despite
  `byCurrency`/`byMonth` in the same function being hand-verified. Writing
  the first hand-computed test (`$1,200` recurring across Jan 15 – Mar 15 →
  3 months → **$400/mo** exactly) failed against the live code — not because
  the arithmetic was wrong, but because the "months spanned" calculation
  used **local-time** date getters (`getFullYear()`/`getMonth()`) on
  instants that are UTC midnight (typically built from date-only strings
  like `"2026-01-01"`). On any server whose timezone is behind UTC — all of
  the Americas, confirmed by reproducing it against this very machine
  (`America/Chicago`) — `new Date('2026-01-01')` reads back as **December
  31, 2025** locally, silently shifting the month/year count and corrupting
  the estimate (a two-entry test case returned `$450`instead of the
correct`$900`). Fixed by switching to `getUTCFullYear()`/`getUTCMonth()`,
matching the UTC convention `byMonth` already used two lines above in the
same function (`periodStart.toISOString().slice(0,7)`) — the bug was an
internal inconsistency between two date-handling conventions in one
function, not a design flaw. Verified: no other `.getMonth()`/
`.getFullYear()`call in`packages/services`mixes UTC-parsed instants
with local getters (the one other hit,`monetization/signals.ts`,
round-trips entirely through local-time `get`/`set`on`new Date()` — the
  current moment — which is self-consistent and not the same bug class).
- _Estimated/labeled (Finding 5, fixed):_ the Revenue tracker page stated
  _"Nothing is pulled from a platform or estimated — this engine never
  invents revenue,"_ directly above a `Recurring ≈ …/mo` figure that **is**
  a calculated estimate. The dollar amounts are indeed 100% user-entered
  (true); the blanket "nothing is... estimated" claim was false for that one
  derived figure. Copy fixed to separate the two claims and to label the
  recurring figure explicitly as this app's own estimate, not just via the
  "≈" glyph.
- _Never invented:_ `addRevenueEntry`/`updateRevenueEntry` only ever persist
  what a user submits (validated: non-negative, ≤ $1B, valid period, 3-letter
  currency); nothing in the module writes a `RevenueEntry` on its own.

## 6. Growth percentages / historical comparisons (reporting engine)

| #   | Metric                                  | Calculation                                                               | Display                           |
| --- | --------------------------------------- | ------------------------------------------------------------------------- | --------------------------------- |
| 1   | `KeyMetric.delta.changePct`             | `reports/sections.ts` `pctChange(from, to) = ((to-from)/                  | from                              | ) × 100`, rounded to 1 decimal, `null`if`from`is`0` or non-finite | report Key Metrics section, PDF export "Change vs previous" column |
| 2   | `HistoricalChanges.changes[].changePct` | same `pctChange`, only for metrics whose formatted value actually changed | report Historical Changes section |

**Verification:**

- _Never a fabricated ∞%/0% on a from-zero baseline:_ `pctChange` returns
  `null` (not `Infinity` or `0`) when the previous value was `0` — already
  correct, confirmed and now covered by an explicit test naming this case
  (in addition to the existing positive-change case).
- _Reproducible (Finding 7c, fixed):_ added an exact negative-change case
  (`8,000` vs. `10,000` → **`-20%`** exactly, direction `"down"`) and an
  exact near-zero case (`10,020` vs. `10,000` → **`+0.2%`**, direction
  `"flat"` — under the `<0.5%` threshold) to `sections.test.ts`, alongside
  the existing hand-verified `+23%` case.
- _Documented, not changed:_ `buildKeyMetrics`/`buildHistoricalChanges` match
  a report's current-vs-previous metric **by label text**
  (`keyMetricKey(m) { return m.label; }`), not a stable key. No metric label
  has ever been renamed, so this is not a live bug — but a future rename
  would silently read as "no previous data" (a `null` delta) rather than a
  real comparison. Fixing this needs a schema change to `KeyMetric`/
  `ReportSnapshot` in `packages/core` (immutable, versioned data per
  ADR-0026) — out of scope for an accuracy-verification phase; flagged here
  as a forward-compatibility risk for whoever next touches a metric label.
- `reports/facts.ts`'s per-type gatherers (`gatherYouTube`, `gatherTikTok`,
  `gatherSeo`, etc.) have no _direct_ unit test today — only the
  `AI_RECOMMENDATIONS` gatherer is exercised via `build.test.ts`. Each
  gatherer is a thin map over the already-unit-tested read functions this
  audit already covers (the real calculation risk lives one layer down);
  documented as a coverage gap for a future QA pass rather than adding
  several more test files to this phase's diff.

---

## Findings summary

| #   | Area                                       | Defect                                                                                                      | Fix                                                               | Test                                                                     |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | YouTube Analytics sync                     | missing requested metric column silently zero-filled                                                        | throw `MalformedApiDataError`, mark run FAILED                    | `youtube/sync.test.ts`                                                   |
| 2   | TikTok video sync                          | missing `create_time` → fabricated 1970-01-01 date                                                          | skip persisting that video                                        | `tiktok/sync.test.ts`                                                    |
| 3   | YouTube Performance page                   | "Net subs (28d)" hardcoded to `pct(null)`                                                                   | wire to real `netSubscribers` value                               | manual + build verification                                              |
| 4   | Search Console aggregate CTR/position      | `0` on zero impressions (Google never reports position 0)                                                   | `null` on zero impressions, schema + UI updated                   | `searchconsole/read.test.ts`                                             |
| 5   | Revenue tracker copy                       | claimed "nothing is estimated" beside a displayed estimate                                                  | corrected copy, explicit "Estimated" label                        | manual review                                                            |
| 6   | `tiktok/metrics.ts`                        | zero test coverage                                                                                          | new hand-verified test file                                       | `tiktok/metrics.test.ts`                                                 |
| 7   | `scoring.ts` / `growthDelta` / `pctChange` | relational-only tests, no exact hand-computed case                                                          | added exact cases to each                                         | `scoring.test.ts`, `youtube/metrics.test.ts`, `reports/sections.test.ts` |
| 8   | `recurringMonthlyByCurrency`               | **live timezone bug**: local-time date getters on UTC instants corrupted the estimate on any non-UTC server | switched to UTC getters, matching `byMonth`'s existing convention | `monetization/revenue.test.ts`                                           |

## Verification run

`pnpm format:check && pnpm lint && pnpm typecheck` — clean, 14/14.
`pnpm --filter @growth-agent/services test` — **671 tests** (654 existing +
17 new/extended across `tiktok/metrics.test.ts`, `youtube/sync.test.ts`,
`tiktok/sync.test.ts`, and hand-verified additions to `scoring.test.ts`,
`youtube/metrics.test.ts`, `reports/sections.test.ts`,
`monetization/revenue.test.ts`, `searchconsole/read.test.ts`), all green —
zero regressions, confirming every fix is additive for data that was already
correct. `pnpm --filter @growth-agent/worker test` — unaffected, green.
`pnpm test:scripts` · `node scripts/check-tenant-scope.mjs` ·
`node scripts/audit-allow.mjs` — clean.
`pnpm --filter @growth-agent/web build` — clean.
