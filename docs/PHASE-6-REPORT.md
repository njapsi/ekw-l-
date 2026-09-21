# PHASE-6-REPORT.md — YouTube Growth Agent (content strategy layer)

## 1. Audit findings (§3 of the brief)

Before writing code, the existing YouTube surface was audited in full:
OAuth (`integrations/google.ts`, read-only scopes only), the Data/Analytics
API client (`youtube/client.ts`, `google-client.ts`, `resilient-client.ts`),
incremental sync (`sync.ts` — channel/video/channel-level-analytics only,
never per-video), derived metrics (`metrics.ts` — `performerSplit`,
`topicClusters`, `windowTotals`, `growthDelta`, `publishingCadence`), the
YouTube Analyst Agent (`analyst.ts`, a grounded model pass + deterministic
fallback), the monetization assessment (`monetization.ts`), the Content
Repurposing engine's YouTube-specific generation (`content/generate.ts` —
13 deliverable types including `YT_TITLE_ALTERNATIVES`/`YT_DESCRIPTION`/
`YT_CHAPTERS`/`SCRIPT`/`HOOK`), the Reporting engine's `YOUTUBE` type
(`reports/facts.ts`), and the Automation engine's `YOUTUBE_ANALYSIS` task
(`automation/dispatch.ts`).

**Conclusion**: most of the brief's conceptual asks already exist under
different names. The one concrete, load-bearing gap: the Growth Agent
orchestrator's capability execution is a **direct function call**
(`agent/capabilities.ts`, `const result = await cap.run(capCtx)`), never
routed through the Phase 5 Tool Registry / Policy Engine / Tool Executor
(`agent/tool-executor.ts`'s `executeAgentTool`) — the brief's own explicit
mandate to "use the existing architecture" for new YouTube functionality.
This became the phase's central integration target (§9 below).

No parallel agent runtime, no second AI application, and no duplicate
content-generation path were built.

## 2. Capability matrix (§6)

`getYouTubeCapabilityMatrix(organizationId)` — `packages/services/src/
youtube/capability-matrix.ts` — reports all 14 named capabilities every
time, never silently omitting one. Seven write-shaped capabilities
(`VIDEO_CREATE/UPDATE/PUBLISH/DELETE`, `PLAYLIST_CREATE/UPDATE/DELETE`)
are always `available: false` with a shared, explicit reason: this
deployment only ever requests `youtube.readonly` / `yt-analytics.readonly`
/ (optionally) `yt-analytics-monetary.readonly` — confirmed by reading
`integrations/google.ts`'s scope registration directly, not assumed.
`AUDIENCE_ANALYTICS_READ`/`TRAFFIC_ANALYTICS_READ` are `available: false`
for a different, also-explicit reason: these dimensions are not synced by
`sync.ts` (a deliberate scope decision, §8 below), independent of OAuth
scope. Five tests (`capability-matrix.test.ts`) cover: all 14 keys present
and unique, not-connected state, the shared write-reason string, the
sync-gap reason distinct from a scope reason, and cross-tenant isolation.

## 3. Benchmarking (§14-16)

`benchmarkVideos(videos)` (`benchmark.ts`) classifies each video against
the **median of its own format bucket** (Short ≤180s vs. long-form) within
the input set — never a global average. Fixed, documented thresholds:
`≥1.5×` peer median ⇒ `OUTPERFORMING`, `≤0.5×` ⇒ `UNDERPERFORMING`, fewer
than 5 comparable peers ⇒ `INSUFFICIENT_DATA` rather than a guess. 10
tests, including the format-bucket-isolation case (Shorts never contaminate
a long-form comparison and vice versa) and the null-viewCount case.

## 4. Content patterns (§17-18)

`detectContentPatterns(videos)` (`patterns.ts`) composes topic-cluster
detection (reusing `metrics.ts`'s existing `topicClusters`, filtering for
above-channel-median clusters) and a format-split check (≥5 videos of each
format, ≥1.2× ratio). 7 tests. Every observation is phrased as a measured
relationship — a dedicated test asserts no pattern text contains "causes."

## 5. Opportunity engine and PRIORITY SCORE (§19-21)

`buildOpportunityDrafts(videos)` (`opportunities.ts`) derives opportunities
only from `benchmarkVideos()`/`detectContentPatterns()` output. The score:

```
priorityScore = 0.35·evidenceStrength + 0.25·historicalPerformance
              + 0.25·contentGap        + 0.15·executionFeasibility
```

named `priorityScore`, never "viral score," documented in one place
(`WEIGHTS`), `audienceRelevance` deliberately omitted for lack of real
audience data (see §8). Persistence mirrors `monetization/opportunities.ts`
exactly: idempotent upsert, `updateYouTubeOpportunityStatus`,
`promoteYouTubeOpportunityToTask` (creates a real `Task`). 6 tests,
including a dedicated assertion that no opportunity text contains
"guarantee" (as a positive claim) or "viral."

## 6. Content calendar (§35-38)

`generateCalendarDrafts` (`calendar.ts`) spreads `cadencePerWeek × weeks`
slots evenly, cycling through ranked opportunities rather than repeating
the top one; a zero-opportunity input produces an honest "idea not yet
assigned" placeholder, never a fabricated topic. `YouTubeCalendarStatus`
has 12 values; every generated entry starts at `IDEA`.
`updateCalendarEntryStatus` explicitly never calls the YouTube API — a
`PUBLISHED` row is a status marker only, mirroring the Content Repurposing
engine's convention. 6 tests.

## 7. Experiments (§39-42)

`evaluateExperiment` (`experiments.ts`) is the one place a conclusion is
decided: a 15%-relative-change floor below which the result is always
`INCONCLUSIVE` regardless of direction; above it, `SUPPORTED` or
`NOT_SUPPORTED` from whether the change matches the expected direction.
Confidence buckets (`HIGH ≥8`/`MEDIUM ≥3`/`LOW <3`) are deliberately
different from the pattern/benchmark buckets, documented as such. 7 tests,
including a case confirming a single dramatic sample is never upgraded past
`LOW` confidence regardless of the ratio.

## 8. Monitoring / anomaly detection (§43-44)

`detectAnomalies` (`monitoring.ts`): trailing-14-day mean/stdDev baseline
(excluding the tested day), z-score thresholds at 2.5σ (`NOTICE`) and 4σ
(`WARNING`), a zero-stdDev metric skipped rather than producing
`Infinity`/`NaN`. `describeAnomaly` renders the exact metric/date/value/
baseline/z-score — never a vague "unusual" claim. 7 tests. Wired into
`automation/dispatch.ts`'s existing `YOUTUBE_ANALYSIS` task: after the
analyst run, daily metrics are checked and any anomaly creates an
idempotent (`dedupeKey`) in-app `Notification` (existing Phase 19 module);
`NOTICE`→`WARNING` level, `WARNING`→`CRITICAL` level (a display mapping
only — the statistical thresholds are unaffected). 1 new dispatch test
covers the notification path end to end with a synthetic spike.

## 9. Tool platform wiring (§62-63) — the central integration target

`agent/youtube-tools.ts` — ten tools (`youtube.channel.get`,
`youtube.channel.analytics`, `youtube.video.list`,
`youtube.content.performance`, `youtube.content.compare`,
`youtube.content.patterns`, `youtube.content.opportunities`,
`youtube.content.calendar.generate`, `youtube.experiment.create`,
`youtube.report.generate`) as a closed allowlist mirroring
`research/tools.ts`'s exact shape. Every capability-gated tool calls
`assertCapabilityUsable` — the identical function `integration-tools.ts`'s
WordPress/Google tools already use. `tool-executor.ts` gained one new
`kindOf()` branch (`'youtube'`) and one explicit dispatch arm; rate
limiting, `TOOL_CALLS` usage metering, and the `AgentRunEvent` timeline are
the existing, unmodified logic applied uniformly. `tool-registry.ts`'s
static metadata catalogue gained the ten tools (all `LOW` risk). 7 tests
(`youtube-tools.test.ts`) cover unknown-tool rejection, input validation
per tool, and capability-gating refusal for every tool when not connected.

## 10. Orchestrator wiring (§67, "use the existing architecture")

A new `youtube-growth` capability (`agent/capabilities.ts`) is the one
capability in the entire Growth Agent that dispatches through
`executeAgentTool` instead of calling a `youtube/*` function directly. It
runs `youtube.content.performance`, `youtube.content.patterns`, and
`youtube.content.opportunities` (`regenerate: true`) concurrently, and
degrades to `needs_prerequisite` — never a crash, never fabricated data —
when YouTube is disconnected or every tool call fails. The pre-existing
`youtube-analyst`/`youtube-monetization` capabilities are untouched
(backward compatibility). The deterministic keyword router gained one
pattern set routing content-opportunity/pattern/benchmark/experiment
language to `youtube-growth`. 4 tests (`capabilities.test.ts`, mocking
`executeAgentTool` to verify real dispatch, argument shape, and safe
degradation) plus an existing-suite assertion that the mapped
recommendations never contain a positive guarantee or virality claim.

## 11. Publishing safety (§64-67)

No publish tool exists, and none can: `integrations/google.ts` never
requests a write scope, so `capability-matrix.ts` reports every write
-shaped capability unavailable regardless of connection state. Asked to
publish, the correct behavior — refuse with the real reason, never attempt
the call — falls out of the architecture rather than needing special-cased
logic; §12 below shows the wording this produces.

## 12. Acceptance-test wording (§125-132), verified by inspection

- **No connection** → `youtube-analyst`/`youtube-monetization`/
  `youtube-growth` all return `needs_prerequisite` with
  `"Connect a YouTube channel from /app/integrations/youtube and run a
sync."` — never a fabricated analysis.
- **No analytics permission** → `youtube.channel.analytics` returns
  `{ available: false, reason: 'Analytics have not been synced for this
channel yet.' }` rather than a zero-filled series.
- **Incomplete data** → benchmarking/pattern detection report
  `INSUFFICIENT_DATA` / omit a pattern below the sample-size floor, never
  guessing.
- **"Make this go viral"** → the opportunity engine's own output is
  asserted (unit test) to never contain a positive "viral" or "guarantee"
  claim; the priority score is explicitly documented as a prioritization
  aid, not a virality prediction.
- **Publish request with no write scope** → `capability-matrix.ts`'s
  `VIDEO_PUBLISH` entry always reports `available: false` with the exact
  reason ("This deployment only ever requests read-only YouTube scopes...
  No write scope is requested, so this action can never succeed regardless
  of connection state"), which any caller (agent or UI) surfaces verbatim.

## 13. Reports and automation wiring

`reports/facts.ts`'s `gatherYouTube` gained (additively): an "open content
opportunities" metric + the top 5 as `ReportOpportunity` rows; a
"completed experiments" metric with the supported/not-supported split; a
running-experiments note. No new report type — the existing seven-section
engine covers it. `automation/dispatch.ts`'s `runYouTubeAnalysis` — see §8.

## 14. Database changes

One additive migration, `20260925120000_youtube_growth_agent`: 4 new
enums (`YouTubeOpportunityType`, `YouTubeExperimentStatus`,
`YouTubeExperimentDirection`, `YouTubeExperimentConclusion`,
`YouTubeCalendarStatus` — 5 enums total), 3 new tables
(`YouTubeOpportunity`, `YouTubeExperiment`, `YouTubeCalendarEntry`), new
relations on `Organization`/`YouTubeChannel`/`ContentIdea`. Hand-authored
`migration.sql`, verified statement-for-statement equivalent (modulo
ordering) to `prisma migrate diff`'s own generated SQL.

## 15. API / Server Action changes

New Server Actions (`apps/web/src/server/youtube-actions.ts`):
`regenerateOpportunitiesAction`, `promoteOpportunityAction`,
`dismissOpportunityAction`, `generateCalendarAction`,
`createExperimentAction` — each behind `requirePermission('agent:run')`,
matching the existing `runAnalystAction`'s authorization convention
exactly. No new REST endpoint was added (Server Actions are this
codebase's established pattern for authenticated mutations, ADR-0006).

## 16. Frontend changes

`/app/youtube/opportunities` gained a new top section showing real
persisted `YouTubeOpportunity` rows (priority score, confidence,
recommended actions, "Add to Tasks"/"Dismiss", a "Regenerate" button)
above the pre-existing, unmodified YouTube Analyst content-ideas section.
`/app/youtube/performance` gained a "Video benchmark" card (top 10 recent
videos, classification badge, ratio-to-peer-median). Two new tabs/pages:
`/app/youtube/calendar` (cadence/weeks form + list) and
`/app/youtube/experiments` (create form + list). All four pages follow
the existing `loadYouTubeState`/`YouTubeEmpty` gating convention used by
every other YouTube page.

## 17. Test coverage summary

New/extended test files: `capability-matrix.test.ts` (5),
`benchmark.test.ts` (10), `patterns.test.ts` (7), `opportunities.test.ts`
(6), `experiments.test.ts` (7), `calendar.test.ts` (6),
`monitoring.test.ts` (7), `youtube-tools.test.ts` (7),
`tool-registry.test.ts` (extended, +0 net after updating the closed-list
assertion), `capabilities.test.ts` (4, new), `dispatch.test.ts` (extended,
+1). **`packages/services` test count: 1100 (+59 since the pre-Phase-6
baseline of 1041 at the end of Phase 5).** `packages/services` typecheck,
lint, and the tenant-scope lint (`scripts/check-tenant-scope.mjs`) all
pass. `apps/web` typecheck, lint, and `next build` all pass, including the
four new/modified routes.

## 18. What was actually tested

- Every new pure function (benchmarking, pattern detection, priority-score
  math, calendar generation, experiment evaluation, anomaly z-scores)
  against hand-built fixtures, including edge cases found and fixed during
  test-writing (documented below).
- The tool dispatcher's input validation and capability-gating refusal
  paths, using the real `assertCapabilityUsable` against an empty
  in-memory database (no connection ⇒ real "not connected" rejection, the
  same code path WordPress/Google tools are already tested against).
- The new orchestrator capability's dispatch shape and safe-degradation
  behavior, with `executeAgentTool` mocked to isolate the capability's own
  logic from the Tool Executor's (already independently tested).
- The full monorepo gate suite: format/lint/typecheck across all 8
  packages, the tenant-scope lint, and a real `next build` of the web app
  including the new routes.

## 19. What requires YouTube credentials (not verified this phase)

- The pre-existing sync path (`sync.ts`) that populates the rows every new
  module in this phase reads — unchanged this phase, not re-verified
  against a live account.
- Whether a real channel's data produces sensible-looking benchmarks/
  patterns/opportunities/anomalies at realistic scale (tested only against
  synthetic fixtures).
- The new tools' end-to-end behavior through a live agent turn against a
  connected, synced channel.

## 20. What requires Google Cloud configuration (not verified this phase)

- Nothing new — no new OAuth scope, no new Google API surface was added
  this phase. The existing `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` requirement
  is unchanged.

## 21. What requires additional API approval

- Nothing new. This phase adds no new scope request of any kind — see §2
  and §11's write-scope discussion, which is the point: no new approval is
  needed because no write capability was built.

## 22. What was not verified

- Live YouTube API behavior for any new or existing call (no credentials
  in this sandbox — same disclosed limitation as every YouTube-touching
  phase since the original integration).
- The UI pages' live rendering in a browser against real data (verified by
  `next build` + typecheck + lint only, not a click-through — this
  sandbox has no way to reach a live, populated organization).
- `reports/facts.ts`'s extended `gatherYouTube` against a real report
  generation run (no dedicated `facts.test.ts` exists for any report type
  in this codebase — an existing gap, not introduced this phase; covered
  indirectly by `reports/build.test.ts`/`sections.test.ts`'s pre-built
  fixtures).

## 23. Bugs found and fixed during this phase (all in new test code, not shipped logic)

- A pattern-detection test's channel median coincided exactly with the
  cluster average it expected to find, silently failing the strict
  inequality check — fixed by adjusting the fixture's video count, not the
  source logic.
- A pattern-detection test used a 2-character tag, which the pre-existing
  `topicClusters` correctly filters (`tag.length < 3`) — fixed the test
  fixture, confirming existing behavior rather than a new bug.
- A monitoring test's expected "modest" anomaly was actually ~15σ (into
  `WARNING` territory) due to an arithmetic error in the fixture — fixed
  by hand-computing the exact offset needed to land between the 2.5σ/4σ
  thresholds, with an inline comment.
- A monitoring test's hand-built flat baseline (stdDev = 0) crashed
  `describeAnomaly` on `undefined` because `detectAnomalies` correctly
  skips a zero-variance metric — fixed by reusing the shared wobbling
  -baseline helper instead of a flat one.

## 24. Documented limitations (do not fake)

- No per-video Analytics-API dimension sync (traffic source, audience
  demographics) — see `docs/YOUTUBE-GROWTH-AGENT.md` §8 for the full
  rationale.
- Five of ten `YouTubeOpportunityType` enum values have no producer yet
  (`AUDIENCE_OPPORTUNITY`, `TRAFFIC_SOURCE_OPPORTUNITY`,
  `SERIES_OPPORTUNITY`, `FORMAT_OPPORTUNITY`, `CONTENT_GAP`) — reserved,
  not fabricated.
- No publish/schedule capability of any kind — by design, not omission
  (§11).
- The Tool Registry's model-driven tool-calling primitive
  (`buildAgentToolDefinitions`) was not extended to include YouTube tools
  — the orchestrator wiring in this phase uses direct `executeAgentTool`
  calls from a capability's own code, not agent-selected tool-calling; see
  ADR-0056's Alternatives section for why extending that further was out
  of scope.

## 25. Remaining technical debt

- `reports/facts.ts` (all report types, not just YouTube) has no dedicated
  unit test file — a pre-existing gap this phase did not close, since
  doing so for every report type is a larger, separate undertaking.
- `capability-matrix.ts`'s reasons for `AUDIENCE_ANALYTICS_READ`/
  `TRAFFIC_ANALYTICS_READ` reference this doc by name in a code comment;
  keep them in sync if the deferred sync work is ever picked up.
- The five reserved `YouTubeOpportunityType` values will need either a
  producer or a decision to remove them, once/if audience or traffic data
  is ever synced.

## 26. Recommended Phase 7 (not started, per the brief's stop condition)

Per the brief's explicit instruction, no Phase 7, TikTok, SEO, or
WordPress work, and no autonomous missions were started. If authorized,
a natural next step is applying the same "one capability calls
`executeAgentTool`" pattern this phase established for YouTube to the
TikTok and SEO domains, and/or extending `sync.ts` for per-video Analytics
dimensions **once real YouTube credentials are available to verify the
API calls against** — not before.

---

**END PHASE 6.** No Phase 7, TikTok, SEO, or WordPress implementation, and
no autonomous missions were started, per the brief's explicit stop
condition (§137).
