# YOUTUBE-GROWTH-AGENT.md

Status: **implemented (operator's "Phase 6")**. Code:
`packages/services/src/youtube/{capability-matrix,benchmark,patterns,
opportunities,experiments,calendar,monitoring}.ts`,
`packages/services/src/agent/youtube-tools.ts`,
`apps/web/app/(app)/app/youtube/{opportunities,calendar,experiments,
performance}`, `apps/web/src/server/youtube-actions.ts`.

This phase extends the existing YouTube integration (OAuth, sync, the
YouTube Analyst Agent, the monetization assessment — all documented in
`docs/YOUTUBE-INTEGRATION.md`) with a **content-strategy layer**: benchmarking
a channel against its own history, detecting content patterns, ranking
content opportunities by a documented priority score, planning a calendar,
running experiments, and detecting statistical anomalies — wired through the
Phase 4 Agent Runtime and Phase 5 Tool Registry / Policy Engine / Tool
Executor rather than a new, parallel path.

No new AI application, no new agent runtime, no new tool-authorization
mechanism was built. Every new tool reuses `assertCapabilityUsable` — the
exact function `wordpress.list_content` and the other Phase 1 integration
tools already use — and every new tool call goes through
`executeAgentTool`, gaining the same rate limiting, `TOOL_CALLS` usage
metering, and `AgentRunEvent` timeline as every other tool call in this
codebase.

---

## 1. The capability matrix — never fake a capability

`getYouTubeCapabilityMatrix(organizationId)` reports 14 named capabilities,
always all 14, never silently omitting one:

| Capability                           | Status                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `CHANNEL_READ`                       | From the Connection Center (`youtube.get_channel`)                                                    |
| `VIDEO_READ`                         | From the Connection Center (`youtube.get_videos`)                                                     |
| `ANALYTICS_READ`                     | From the Connection Center (`youtube.get_analytics`)                                                  |
| `REVENUE_ANALYTICS_READ`             | From the Connection Center (`youtube.get_revenue` — needs the opt-in monetary scope)                  |
| `PLAYLIST_READ`                      | Only the uploads playlist (video discovery); connected ⇒ available                                    |
| `AUDIENCE_ANALYTICS_READ`            | **Always unavailable** — age/gender/subscribed-status breakdowns are not synced by `sync.ts` (see §8) |
| `TRAFFIC_ANALYTICS_READ`             | **Always unavailable** — traffic-source breakdowns are not synced by `sync.ts` (see §8)               |
| `VIDEO_CREATE/UPDATE/PUBLISH/DELETE` | **Always unavailable** — this deployment never requests a write scope                                 |
| `PLAYLIST_CREATE/UPDATE/DELETE`      | **Always unavailable** — same reason                                                                  |

The seven write-shaped capabilities share one string
(`NEVER_REQUESTED_REASON`) explaining exactly why: `integrations/google.ts`
only ever registers `youtube.readonly`, `yt-analytics.readonly`, and
optionally `yt-analytics-monetary.readonly` for the `YOUTUBE` OAuth
provider. There is no code path — connected or not — that could ever make a
write call succeed. This satisfies the master instruction's acceptance test:
asked to publish, the agent must say it can prepare content but cannot
publish because the connection does not grant that capability, never attempt
the call.

---

## 2. Benchmarking — the channel against its own history

`benchmarkVideos(videos)` (`benchmark.ts`) classifies each video
`OUTPERFORMING / TYPICAL / UNDERPERFORMING / INSUFFICIENT_DATA` against the
**median of its own format bucket** among the input set — never a global
YouTube average, and Shorts are never compared against long-form or vice
versa.

- **Format split**: `≤180s` = Short (YouTube's own Shorts duration
  threshold at the time of writing), else long-form (`classifyFormat`).
- **Minimum peers**: fewer than 5 comparable videos in the same bucket ⇒
  `INSUFFICIENT_DATA` — the module refuses to guess rather than compare
  against a meaningless sample, mirroring `metrics.ts`'s pre-existing
  `performerSplit` convention.
- **Thresholds** (fixed, documented, never invented by a model):
  `≥1.5×` the peer median ⇒ `OUTPERFORMING`; `≤0.5×` ⇒ `UNDERPERFORMING`;
  otherwise `TYPICAL`.

`compareVideos()` is the same function exposed for a caller-chosen,
bounded video set (`youtube.content.compare`). `getRecentVideoBenchmarks`
is the read composition the `/app/youtube/performance` page and the
`youtube.content.performance` tool both use.

**Deliberate scope choice**: benchmarking uses the already-reliably-synced
lifetime Data-API stats (`viewCount`/`likeCount`/`commentCount`), not a
day-by-day Analytics-API breakdown per video — see §8.

---

## 3. Content patterns

`detectContentPatterns(videos)` (`patterns.ts`) composes two deterministic
checks, never a model guess:

- **Topic clusters** (`topicPatterns`): reuses `metrics.ts`'s existing
  `topicClusters` (tag co-occurrence, ≥2 shared videos, tags <3 chars
  filtered), keeping only clusters whose average views exceed the channel
  median. Phrased as an observed relationship ("videos tagged X have
  average views of...") — never "causes."
- **Format split** (`formatPatterns`): requires ≥5 Shorts and ≥5 long-form
  videos and at least a 1.2× ratio difference between their medians before
  reporting a pattern.

Each `ContentPattern` carries `confidence: HIGH (≥10 videos) / MEDIUM (≥5) /
LOW (<5)` — a different sample-size bucketing than experiments (§6),
documented in each file as deliberately domain-specific rather than a
single shared constant.

---

## 4. The opportunity engine and PRIORITY SCORE

`buildOpportunityDrafts(videos)` (`opportunities.ts`) derives opportunities
**only** from `benchmarkVideos()` and `detectContentPatterns()` output —
never invented, never from a model. Five of the ten
`YouTubeOpportunityType` values are currently produced:
`HIGH_PERFORMER_FOLLOWUP`, `UNDEREXPLOITED_TOPIC`, `CONTENT_EXPANSION`,
`SHORTS_OPPORTUNITY`, `LONG_FORM_OPPORTUNITY` (the remaining five —
`AUDIENCE_OPPORTUNITY`, `TRAFFIC_SOURCE_OPPORTUNITY`, `SERIES_OPPORTUNITY`,
`FORMAT_OPPORTUNITY`, `CONTENT_GAP` — are reserved enum values with no
producer, since the first two need the audience/traffic data this
deployment does not sync (§8) and the rest were not needed to satisfy the
brief's named opportunity types).

### The formula — called PRIORITY SCORE, never a "viral score"

```
priorityScore = 0.35·evidenceStrength + 0.25·historicalPerformance
              + 0.25·contentGap        + 0.15·executionFeasibility
```

Weights sum to 1 and are a single named constant (`WEIGHTS`) — changing them
is a product decision, never a model's choice. **`audienceRelevance`** from
the brief's own example factor list is deliberately **omitted**: this
deployment has no audience-demographic data (§8), and inventing a
placeholder value for an unmeasured factor would fabricate data (hard rule
1). The four factors actually used are each backed by a real, computed
value — none of them predicts views, and no output text anywhere in this
module contains "guarantee" or "viral" (enforced by
`opportunities.test.ts`).

`upsertOpportunities` is idempotent — keyed on
`(organizationId, youTubeChannelId, type, title, status ∈ {SUGGESTED,
IN_PROGRESS, ACTIVE})` — so regenerating does not create duplicate rows for
an opportunity that is still open. `updateYouTubeOpportunityStatus` and
`promoteYouTubeOpportunityToTask` mirror the Monetization engine's
equivalent functions exactly (`monetization/opportunities.ts`), reusing the
`OpportunityStatus` enum and the `Task` model rather than inventing parallel
ones.

---

## 5. Content calendar

`generateCalendarDrafts(input)` (`calendar.ts`) is pure: it spreads
`cadencePerWeek × weeks` slots evenly across the window, **cycling through**
the ranked opportunities (`i % opportunities.length`) rather than repeating
only the top one. With zero opportunities, a slot is left as an honest
placeholder — `"Content slot N — idea not yet assigned"` — never a
fabricated topic. `YouTubeCalendarStatus` has 12 values
(`IDEA → PLANNED → BRIEFED → SCRIPTED → DRAFT → READY → APPROVAL_REQUIRED →
SCHEDULED → PUBLISHED → ANALYZING → COMPLETED`, plus `CANCELLED`); every
generated entry starts at `IDEA`. `updateCalendarEntryStatus`'s own comment
states explicitly that setting a row to `PUBLISHED` is a **status marker
only** — this function never calls the YouTube API, mirroring the Content
Repurposing engine's `markAssetPublished` convention (hard rule 4: no
publish without explicit action through a real integration, which does not
exist for YouTube writes at all — §1).

---

## 6. Experiments — never a forced winner

A `YouTubeExperiment` is a controlled test the creator runs deliberately:
`hypothesis`, `variable`, `baseline`, `successMetric`,
`expectedDirection ∈ {INCREASE, DECREASE}`.

`evaluateExperiment(baselineValue, experimentValue, expectedDirection,
sampleSize)` (`experiments.ts`) is the **one** place a conclusion is
decided — a pure, documented comparison, never a model's opinion:

- **Meaningful-change threshold**: a relative change below **15%**
  (`MEANINGFUL_CHANGE_RATIO`) is always `INCONCLUSIVE`, regardless of
  direction — mirroring `benchmark.ts`'s ±50%/±150% documented-threshold
  convention rather than inventing a new one.
- Above threshold: `SUPPORTED` when the change matches the expected
  direction, `NOT_SUPPORTED` when it moves the opposite way.
- **Confidence from sample size**: `HIGH ≥8`, `MEDIUM ≥3`, `LOW <3` —
  deliberately different bucketing than patterns/benchmarks (§3), since an
  experiment's "sample" (days/videos compared) and a pattern's "sample"
  (videos in a cluster) are not the same kind of measurement.

`completeExperiment` persists the evaluation, including a JSON `result`
blob — the conclusion is never silently recomputed or overwritten by a
later run.

---

## 7. Anomaly monitoring — a transparent statistical baseline

`detectAnomalies(daily)` (`monitoring.ts`) compares the most recent day
against the **trailing 14-day mean and standard deviation** (excluding the
day itself) for three metrics: `views`, `estimatedMinutesWatched`,
`netSubscribers`.

- Fewer than 15 total days of history ⇒ returns `[]` — no baseline, no
  guess.
- A perfectly flat baseline (`stdDev = 0`) is skipped for that metric,
  avoiding a division by zero / `Infinity` z-score.
- **Z-score thresholds** (fixed, documented): `≥2.5σ` ⇒ `NOTICE`;
  `≥4σ` ⇒ `WARNING`. Never every fluctuation is flagged — day-to-day noise
  within ±2.5σ of the trailing baseline is not reported at all.
- `describeAnomaly(anomaly)` renders the exact metric, date, value,
  baseline mean ± stdDev, and z-score as a sentence — never a vague
  "unusual activity" claim.

**Automation wiring** (`automation/dispatch.ts`'s `runYouTubeAnalysis`):
after the existing analyst run, the channel's daily metrics are checked for
anomalies; each one creates an idempotent (`dedupeKey`) in-app
`Notification` via the existing notifications module (Phase 19). A `NOTICE`
severity anomaly surfaces as a `WARNING`-level notification; a `WARNING`
severity one (a genuinely extreme ~4σ deviation) surfaces as `CRITICAL` —
a **display-level mapping only**; the statistical thresholds themselves are
unchanged by this mapping.

---

## 8. What was deferred, and why

- **No per-video Analytics-API sync** (traffic source, audience
  demographics, per-video day-by-day breakdowns). `sync.ts`'s
  `syncAnalytics` is channel-level only (`dimensions: ['day']`), and the
  master instruction itself warns against constructing unsupported
  metric/dimension combinations. This environment has no live YouTube
  credentials to verify a new dimension combination against the real API,
  so extending `sync.ts` this phase would have risked exactly the failure
  mode the brief warns against. `AUDIENCE_ANALYTICS_READ` and
  `TRAFFIC_ANALYTICS_READ` report `available: false` for this reason, not
  because of an OAuth scope limitation — the scope for analytics is
  already granted when analytics are synced at all.
- **No publish/schedule capability of any kind.** §1 covers this — no
  write scope is ever requested, so there is nothing to gate; the calendar
  and experiments are planning tools only.
- **No live YouTube API verification.** Every new module here
  (`benchmark.ts`, `patterns.ts`, `opportunities.ts`, `experiments.ts`,
  `calendar.ts`, `monitoring.ts`) operates on already-synced database rows;
  none of it makes a new YouTube API call. The existing sync path
  (`sync.ts`) that populates those rows was not modified and was not
  re-verified against a live account this phase (no real OAuth credentials
  exist in this sandbox — same disclosed limitation as every YouTube-
  touching phase since the original integration).

---

## 9. Tool platform wiring (Phase 4/5 architecture, not a new one)

`packages/services/src/agent/youtube-tools.ts` is a closed allowlist —
`YOUTUBE_TOOL_NAMES`, a `YouTubeTool` interface (Zod-validated input +
`execute`), and `runYouTubeTool(name, ctx, input)` — mirroring
`research/tools.ts`'s exact shape. Ten tools:

| Tool                                | Capability gate         |
| ----------------------------------- | ----------------------- |
| `youtube.channel.get`               | `youtube.get_channel`   |
| `youtube.channel.analytics`         | `youtube.get_analytics` |
| `youtube.video.list`                | `youtube.get_videos`    |
| `youtube.content.performance`       | `youtube.get_videos`    |
| `youtube.content.compare`           | `youtube.get_videos`    |
| `youtube.content.patterns`          | `youtube.get_videos`    |
| `youtube.content.opportunities`     | `youtube.get_videos`    |
| `youtube.content.calendar.generate` | `youtube.get_videos`    |
| `youtube.experiment.create`         | `youtube.get_channel`   |
| `youtube.report.generate`           | `youtube.get_channel`   |

Every gate calls `assertCapabilityUsable` — the same function
`integration-tools.ts`'s WordPress/Google tools already use — never a
second authorization mechanism. `tool-executor.ts`'s `kindOf()` gained one
new branch (`'youtube'`, alongside `'native' | 'research' | 'mcp'`) and the
main dispatch `if/else if` chain gained one explicit branch calling
`runYouTubeTool`; the rate limiting, `TOOL_CALLS` usage metering, and
`AgentRunEvent` timeline (`TOOL_SELECTED → TOOL_AUTHORIZATION_CHECK →
TOOL_STARTED → TOOL_COMPLETED/TOOL_FAILED`) are the existing, unmodified
logic applied uniformly to every kind.

`tool-registry.ts`'s static catalogue (`listToolMetadata`) was extended
with the ten tools' category/risk metadata (all `LOW` risk, `READ` /
`ANALYSIS` / `GENERATION` — none writes anything) for a complete, accurate
discovery surface; `buildAgentToolDefinitions` (the dormant, Phase-4-only
model-tool-calling primitive) was **not** extended — see
`docs/AGENT-RUNTIME.md` §6 for why that primitive stays unwired for every
domain, YouTube included, this phase.

**Deliberately not built as separate tools** (duplicating existing
functionality would violate hard rule 9): `youtube.content.idea.generate` /
`.title.generate` / `.description.generate` / `.script.generate` /
`.brief.generate` — the Content Repurposing engine's 13 deliverable types
(`content/generate.ts`) already cover this for a synced YouTube video.
Separate `youtube.report.weekly.generate` / `.monthly.generate` tools —
the reporting engine's `YOUTUBE` type has no weekly-vs-monthly distinction
of its own (it always reports "since the last report"); cadence is an
automation-schedule concern (`automation/dispatch.ts`'s `GROWTH_REPORT`
task type already supports scheduling a report), not a tool-shape concern.

### Orchestrator wiring

A new `youtube-growth` capability (`agent/capabilities.ts`) is the one
capability in the whole Growth Agent that dispatches through
`executeAgentTool` rather than calling a `youtube/*` function directly —
demonstrating the Phase 4/5 architecture is actually load-bearing for new
functionality, not merely built and left unused. It calls
`youtube.content.performance`, `youtube.content.patterns`, and
`youtube.content.opportunities` (with `regenerate: true`) concurrently,
turns the results into evidence + recommendations, and degrades to
`needs_prerequisite` when YouTube is not connected or every underlying
tool call fails — never a crash, never fabricated data.
`youtube-analyst` and `youtube-monetization` (the pre-existing
capabilities) are **untouched** — this is new surface area, not a
replacement (backward compatibility). `CapabilityContext` gained an
optional `agentRunId` field so a capability's tool calls attach to the
same turn's `AgentRunEvent` timeline the capability itself is already
recorded against.

The deterministic keyword router (`planner.ts`) gained one new pattern
(content opportunity / idea / pattern / calendar / benchmark / outperform /
compare videos / experiment / A/B test) routing to `youtube-growth`.

---

## 10. Reports and dashboard

`reports/facts.ts`'s `gatherYouTube` (the `YOUTUBE` report type) is
extended, additively, with: an "open content opportunities" metric and the
top 5 opportunities as `ReportOpportunity` rows; a "completed experiments"
metric noting how many supported their hypothesis; a note when experiments
are currently running. No new report type was added — the existing
seven-section, seven-type reporting engine already covers this.

---

## 11. UI

`/app/youtube/opportunities` gained a new top section showing real,
persisted `YouTubeOpportunity` rows (priority score, confidence,
recommended actions, "Add to Tasks" / "Dismiss" actions, "Regenerate"
button) above the pre-existing YouTube Analyst content-ideas/suggestions
section, which is unchanged. `/app/youtube/performance` gained a "Video
benchmark" card showing the top 10 recent videos' classification against
their own format-bucket peers. Two new tabs/pages: `/app/youtube/calendar`
(generate + list) and `/app/youtube/experiments` (create + list).
