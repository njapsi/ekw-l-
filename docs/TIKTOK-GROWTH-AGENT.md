# TIKTOK-GROWTH-AGENT.md

Status: **implemented (operator's "Phase 7")**. Code:
`packages/services/src/tiktok/{capability-matrix,benchmark,patterns,
opportunities,experiments,calendar,monitoring}.ts`,
`packages/services/src/agent/tiktok-tools.ts`,
`apps/web/app/(app)/app/tiktok/{opportunities,calendar,experiments,
performance}`, `apps/web/src/server/tiktok-actions.ts`.

This phase extends the existing TikTok integration (OAuth via Login Kit +
PKCE, incremental sync, the TikTok Analyst Agent, and — unlike YouTube — a
**real, already-audited Content Posting API publishing flow**; all
documented in `docs/TIKTOK-INTEGRATION.md`) with the same content-strategy
layer Phase 6 built for YouTube: benchmarking against the account's own
history, content-pattern detection, a priority-scored opportunity engine,
content-plan generation, an experiment system, and anomaly monitoring —
wired through the Phase 4 Agent Runtime and Phase 5 Tool Registry / Policy
Engine rather than a new path.

No new AI application, no new agent runtime, and no duplicate publishing
flow were built. Publishing already existed and works correctly; this
phase's one publish-adjacent addition (`tiktok.content.publish.draft`) is a
thin, correctly-gated wrapper around the existing, already-audited
`publish.ts` draft flow — it never submits anything itself.

---

## 1. Audit findings

Before writing code, the existing TikTok surface was audited in full and
found to be a **mature, production-shaped vertical slice** — more mature
than YouTube was pre-Phase-6, since it already has genuine write/publish
capability: real OAuth (PKCE + signed, session-bound state), a typed
Display API client + Content Posting API client with resilient retry/
backoff, incremental account/video sync, derived metrics
(`engagementRate`/`postingCadence`/`performerSplit`/`themeClusters`), a
grounded TikTok Analyst Agent with the same fact-sheet/grounding-check
discipline as YouTube's, and a **real, already-audited publish flow**
(`publish.ts`: draft → explicit human approval → submit via
`PULL_FROM_URL` → status polling → audit log at every transition, with a
content-hash dedupe guard re-checked at both draft-creation and
submit-time). Nothing found in the audit was mocked or faked; every "not
available" case was already either gated behind a real scope check or
documented as a genuine TikTok API/product absence.

**Conclusion**: the one concrete gap, mirroring Phase 6's finding for
YouTube, was the same architectural one — the Growth Agent orchestrator's
`tiktok-analyst` capability calls `tiktok/*` functions directly, never
through the Phase 5 Tool Registry / Policy Engine / Tool Executor. This
became this phase's integration target.

---

## 2. The capability matrix

`getTikTokCapabilityMatrix(organizationId)` reports 12 named capabilities
every time, using the richer AVAILABLE / REQUIRES_APPROVAL / NOT_AVAILABLE
vocabulary the brief asks for (rather than YouTube's simpler boolean
shape), plus a `level` (READ_ONLY / WRITE / PUBLISH / DELETE):

| Capability                | Level     | Availability                                                                                                                                                           |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_READ`            | READ_ONLY | From the Connection Center (`tiktok.get_profile`)                                                                                                                      |
| `VIDEO_READ`              | READ_ONLY | From the Connection Center (`tiktok.get_videos`)                                                                                                                       |
| `VIDEO_ANALYTICS_READ`    | READ_ONLY | Same scope as `VIDEO_READ` — TikTok's `video.list` already returns each video's lifetime counts, there is no separate analytics endpoint                               |
| `CONTENT_ANALYTICS_READ`  | READ_ONLY | **Always `NOT_AVAILABLE`** — TikTok's Display API has no day-by-day analytics endpoint at all (a product absence, not a permission gap)                                |
| `AUDIENCE_ANALYTICS_READ` | READ_ONLY | **Always `NOT_AVAILABLE`** — no public API for audience demographics                                                                                                   |
| `COMMENTS_READ`           | READ_ONLY | **Always `NOT_AVAILABLE`** — no public API for comment reading                                                                                                         |
| `CONTENT_DRAFT`           | WRITE     | AVAILABLE when the connection has the `video.publish` scope                                                                                                            |
| `CONTENT_PUBLISH`         | PUBLISH   | `REQUIRES_APPROVAL` when the scope is granted (this app's own approval gate, **and** TikTok's own audit gate for public visibility); `NOT_AVAILABLE` without the scope |
| `VIDEO_UPDATE`            | WRITE     | **Always `NOT_AVAILABLE`** — no such TikTok API endpoint                                                                                                               |
| `VIDEO_DELETE`            | DELETE    | **Always `NOT_AVAILABLE`** — no such TikTok API endpoint                                                                                                               |
| `COMMENT_MANAGEMENT`      | WRITE     | **Always `NOT_AVAILABLE`** — no such TikTok API endpoint                                                                                                               |
| `SCHEDULE_PUBLISH`        | PUBLISH   | **Always `NOT_AVAILABLE`** — TikTok's Content Posting API has no future-publish parameter, and this deployment has no scheduler for it                                 |

### A real bug this phase caught and fixed: `tiktok.publish`'s `usable` flag is structurally always false

`integrations/contract.ts`'s `resolveCapabilities` promotes a
`REQUIRES_SCOPE` baseline to `AVAILABLE` once the scope is granted, but
**deliberately never** promotes a `REQUIRES_PROVIDER_APPROVAL` baseline the
same way (TikTok public posting always needs an app audit, regardless of
scope). `tiktok.publish`'s contract descriptor uses exactly that baseline —
so `cap.usable` for this one capability is **always `false`**, by design,
independent of whether the connection actually has `video.publish`. That is
correct for the Connection Center's own display purpose (it should always
show "needs approval"), but the first draft of this phase's capability
matrix and its `tiktok.content.publish.draft` tool both mistakenly gated on
`.usable`, which would have made the agent tool (and a naive capability
-matrix reading) wrongly report drafting as impossible even when the scope
IS granted and a `SELF_ONLY` draft would work today — exactly what the
existing, real `createTikTokDraftAction` Server Action already allows,
unaudited. Both were fixed to check the connection's actual granted scope
directly (`entry.scopes.includes('video.publish')`) instead of `.usable`
for this one capability, caught by a unit test built specifically to
exercise a connected-with-scope fixture rather than only the empty-db case.

---

## 3. Benchmarking

`benchmarkVideos(videos)` (`benchmark.ts`) classifies each video against
the median of its own **duration bucket** — `short` (≤60s, TikTok's
conventional short-form cutoff) vs. `extended` (>60s, since TikTok now
supports videos up to several minutes) — within the input set, never a
global average. Same fixed thresholds as YouTube's benchmark module
(`≥1.5×`/`≤0.5×` peer median, minimum 5 peers, else `INSUFFICIENT_DATA`).
9 tests.

---

## 4. Content patterns

`detectContentPatterns(videos)` (`patterns.ts`) composes: hashtag clusters
(reusing `metrics.ts`'s existing `themeClusters`, filtering for
above-account-median clusters) and a short-vs-extended duration split
(requires ≥5 of each bucket and a ≥1.2× ratio). Every observation is
phrased as a measured relationship, never a causal claim (asserted by
test). 7 tests.

---

## 5. The opportunity engine and PRIORITY SCORE

`buildOpportunityDrafts(videos)` (`opportunities.ts`) — the identical
four-factor weighted formula as YouTube's:

```
priorityScore = 0.35·evidenceStrength + 0.25·historicalPerformance
              + 0.25·contentGap        + 0.15·executionFeasibility
```

`audienceRelevance` is deliberately omitted (no TikTok audience data
exists — §2). Five of seven `TikTokOpportunityType` values are produced
(`HIGH_PERFORMER_FOLLOWUP`, `UNDEREXPLOITED_TOPIC`, `CONTENT_EXPANSION`,
`SHORT_FORMAT_OPPORTUNITY`, `EXTENDED_FORMAT_OPPORTUNITY`); two are
reserved but unproduced (`AUDIENCE_OPPORTUNITY`, `TREND_OPPORTUNITY` — no
data source exists for either). Persistence mirrors
`youtube/opportunities.ts` exactly. 6 tests, including a dedicated
assertion against a positive guarantee/virality claim.

---

## 6. Content plan (calendar)

`generateContentPlanDrafts` (`calendar.ts`) — identical logic to YouTube's
calendar generator: spreads `cadencePerWeek × weeks` slots evenly, cycles
through ranked opportunities, and falls back to an honest "idea not yet
assigned" placeholder for an empty slot, never fabricating a topic. Model
name is `TikTokContentPlan` (not `TikTokCalendarEntry`) to match this
phase's own brief naming. `TikTokContentPlanStatus` has the same 12
pipeline states as YouTube's; `updateContentPlanStatus`'s own comment
states explicitly that a `PUBLISHED` row is a status marker set by the
user, **deliberately independent** of the real `TikTokPublish` state
machine — the two systems are never conflated. 6 tests.

---

## 7. Experiments

`evaluateExperiment` (`experiments.ts`) — identical to YouTube's: a 15%
-relative-change floor below which the result is always `INCONCLUSIVE`;
confidence buckets `HIGH ≥8`/`MEDIUM ≥3`/`LOW <3`. 8 tests.

---

## 8. Anomaly monitoring — adapted for TikTok's lack of a daily time series

TikTok's `TikTokMetric` table is an **irregularly-spaced periodic
snapshot**, never a daily table — a real, documented API limitation (§2),
unlike YouTube's proper day-by-day Analytics data. A trailing-14-calendar
-day baseline the way `youtube/monitoring.ts` computes it therefore does
not directly apply.

`detectAccountAnomalies` (`monitoring.ts`) instead works over **per-day
growth rates between consecutive snapshots**: each consecutive pair of
snapshots is turned into a `(Δvalue / elapsed days)` figure — which stays
comparable even when the snapshots themselves are unevenly spaced — and
the anomaly check (a transparent trailing mean/stdDev z-score, the same
2.5σ `NOTICE` / 4σ `WARNING` thresholds as YouTube) runs over that
normalized rate series instead of the raw values. A pair captured less
than half a day apart is dropped entirely, rather than letting a near-zero
elapsed-time denominator dominate the rate. Two metrics are tracked:
`followerGrowthRate` and `likesGrowthRate`. 7 tests, including one
confirming a near-duplicate snapshot pair is correctly dropped rather than
producing a spurious anomaly.

Wired into `automation/dispatch.ts`'s existing `TIKTOK_ANALYSIS` task
exactly like YouTube's: after the analyst run, snapshots are checked and
any anomaly creates an idempotent (`dedupeKey`) in-app `Notification`,
using the same `NOTICE`→`WARNING`/`WARNING`→`CRITICAL` display-level
mapping.

---

## 9. Tool platform wiring — the central integration target

`agent/tiktok-tools.ts` — ten tools, dispatched through the existing
`executeAgentTool` (Phase 5), each capability-gated via
`assertCapabilityUsable` (the same function WordPress/Google/YouTube tools
already use):

| Tool                               | Capability gate      |
| ---------------------------------- | -------------------- |
| `tiktok.account.get`               | `tiktok.get_profile` |
| `tiktok.video.list`                | `tiktok.get_videos`  |
| `tiktok.content.performance`       | `tiktok.get_videos`  |
| `tiktok.content.compare`           | `tiktok.get_videos`  |
| `tiktok.content.patterns`          | `tiktok.get_videos`  |
| `tiktok.content.opportunities`     | `tiktok.get_videos`  |
| `tiktok.content.calendar.generate` | `tiktok.get_videos`  |
| `tiktok.experiment.create`         | `tiktok.get_profile` |
| `tiktok.report.generate`           | `tiktok.get_profile` |
| `tiktok.content.publish.draft`     | none (see below)     |

`tool-executor.ts` gained one new `'tiktok'` kind alongside `'youtube'`;
the rate limiting, `TOOL_CALLS` usage metering, and `AgentRunEvent`
timeline are the existing, unmodified logic applied uniformly.
`tool-registry.ts`'s static catalogue gained the ten tools' metadata (nine
`LOW` risk; `tiktok.content.publish.draft` is `MEDIUM` risk, category
`ACTION`, `requiresApproval: true` — matching `integrations.propose_action`'s
exact treatment).

**Deliberately not built as separate tools** (§24: "Only expose tools
whose underlying capability actually exists"): `tiktok.content.idea
.generate` / `.hook.generate` / `.caption.generate` / `.hashtags.generate`
/ `.script.generate` / `.brief.generate` — already covered by the Content
Repurposing engine's `TIKTOK_IDEA` / `TIKTOK_CAPTION` deliverable types
plus the generic `SCRIPT`/`HOOK` types (`content/generate.ts`), which
already accept a synced TikTok video as their source. A second,
TikTok-specific generation path would duplicate existing functionality
(hard rule 9). `tiktok.analytics.audience` — no underlying capability
exists (§2). Separate weekly/monthly report tools — the reporting engine's
`TIKTOK` type has no such distinction; one `tiktok.report.generate` tool
is offered instead, matching the YouTube tool set's equivalent choice.

### `tiktok.content.publish.draft` — the one tool that touches a real write path

This tool creates a real `AWAITING_APPROVAL` `TikTokPublish` draft via the
existing, already-audited `publish.ts` flow — but **never submits**.
Submission requires a human to click "Approve & publish" in the UI, which
is the only caller that ever passes `approve: true` to `approveAndSubmit`.

Because `publish:external` is an ADMIN+-only permission distinct from the
`agent:run` permission that lets any MEMBER reach this tool at all, the
tool re-derives the caller's authorization from the database at call time
via `assertJobAuthorized` (`security/job-auth.ts`'s existing "never trust
a role carried in a payload" convention, built for background jobs and
reused here for the same reason) — it never assumes `agent:run` implies
publish rights. A dedicated test constructs a connected-with-scope
fixture and a MEMBER-role caller and confirms the tool is refused despite
having a usable connection, closing exactly the privilege-escalation gap
this check exists to prevent.

The tool is **not** gated on `assertCapabilityUsable(ctx, 'tiktok.publish')`
— see §2's bug writeup for why that would incorrectly block the tool even
with the scope granted. Instead it relies on `createPublishDraft`'s own
internal scope validation, exactly like the real `createTikTokDraftAction`
Server Action already does.

---

## 10. Orchestrator wiring

A new `tiktok-growth` capability (`agent/capabilities.ts`) is the one
TikTok capability that dispatches through `executeAgentTool` instead of
calling a `tiktok/*` function directly — mirroring `youtube-growth`
exactly. It calls `tiktok.content.performance`, `tiktok.content.patterns`,
and `tiktok.content.opportunities` (`regenerate: true`) concurrently, and
degrades to `needs_prerequisite` when TikTok is not connected or every
tool call fails. `tiktok-analyst` is untouched. The deterministic keyword
router (`planner.ts`) gained a matching pattern set (content opportunity /
idea / pattern / calendar / benchmark / outperform / compare videos /
experiment / hashtag) routing to `tiktok-growth`.

---

## 11. Reports and automation

`reports/facts.ts`'s `gatherTikTok` gained, additively: an "open content
opportunities" metric + the top 5 as `ReportOpportunity` rows; a
"completed experiments" metric with the supported/not-supported split; a
running-experiments note — identical extension to YouTube's. No new
report type. `automation/dispatch.ts`'s `runTikTokAnalysis` — see §8.

---

## 12. Database

One additive migration, `20260926120000_tiktok_growth_agent`: 5 new enums
(`TikTokOpportunityType`, `TikTokExperimentStatus`,
`TikTokExperimentDirection`, `TikTokExperimentConclusion`,
`TikTokContentPlanStatus`), 3 new tables (`TikTokOpportunity`,
`TikTokExperiment`, `TikTokContentPlan`). Verified statement-for-statement
equivalent to `prisma migrate diff`'s own generated SQL.

Per the brief's §7 "at minimum" model list, several named models were
deliberately **not** created because an equivalent already exists (hard
rule 9, "avoid unnecessary dependencies"):

- `TikTokProfile` — redundant with `TikTokAccount`'s existing fields.
- `TikTokVideoAnalytics` — redundant with `TikTokVideo`'s embedded lifetime
  counts plus the existing `TikTokMetric` snapshot table.
- `TikTokAudienceSnapshot` — no audience data exists to snapshot (§2); a
  table with no real data source would be pure schema noise, or worse, an
  invitation to fabricate.
- `TikTokRecommendation` — the existing generic `Recommendation` model
  (already used with `domain: 'TIKTOK'`) covers this.
- `TikTokApiEvent` — the existing `TikTokSyncRun.error` field, the audit
  module, and `IntegrationHealth` already cover API-event observability;
  a fourth logging surface would duplicate all three.
- `TikTokContentPattern` — patterns are cheap to recompute on demand from
  already-synced videos (`detectContentPatterns`); persisting them would
  need a cache-invalidation strategy for no real benefit at this scale,
  matching the YouTube precedent (`ContentPattern` is also ephemeral there).

---

## 13. UI

`/app/tiktok/opportunities` gained a new top section showing real,
persisted `TikTokOpportunity` rows (priority score, confidence,
recommended actions, "Add to Tasks"/"Dismiss", "Regenerate") above the
pre-existing, unmodified TikTok Analyst content-ideas section.
`/app/tiktok/performance` gained a "Video benchmark" card. Two new
tabs/pages: `/app/tiktok/calendar` (cadence/weeks form + list) and
`/app/tiktok/experiments` (create form + list).

---

## 14. What was actually tested vs. not (see `docs/PHASE-7-REPORT.md` for the full breakdown)

Every new pure function was unit-tested against hand-built fixtures. The
tool dispatcher's capability-gating and RBAC-recheck paths were tested
against the real `assertCapabilityUsable`/`assertJobAuthorized` functions
using an in-memory database, including the connected-with-scope fixture
that caught the `tiktok.publish` `.usable` bug (§2). No live TikTok API
call was made or could be made — this sandbox has no real TikTok developer
credentials, the same disclosed limitation as every TikTok-touching phase
since the original integration.
