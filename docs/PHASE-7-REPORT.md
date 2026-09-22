# PHASE-7-REPORT.md — TikTok Growth Agent

```
PHASE 7 COMPLETE

TikTok OAuth:            PASS (pre-existing, unchanged, re-verified by audit)
TikTok API:               PASS (pre-existing, unchanged, re-verified by audit)
Account sync:              PASS (pre-existing, unchanged, re-verified by audit)
Video sync:                PASS (pre-existing, unchanged, re-verified by audit)
Analytics:                 PARTIAL — lifetime per-video counts + periodic
                            account snapshots only; no day-by-day time
                            series exists in TikTok's public API (documented
                            product absence, not a gap in this phase's work)
AI analysis:                PASS (pre-existing analyst, unchanged; new
                            tiktok-growth orchestrator capability added)
Content generation:         PASS (existing Content Repurposing engine's
                            TIKTOK_IDEA/TIKTOK_CAPTION/SCRIPT/HOOK types;
                            deliberately not duplicated by new tools)
Experiments:                PASS (new this phase)
Reports:                    PASS (existing TIKTOK report type, extended)
Background jobs:            PASS (existing TIKTOK_ANALYSIS automation task,
                            extended with anomaly detection)
Publishing:                 PASS (pre-existing, real, audited flow,
                            unchanged) / APPROVAL REQUIRED for public
                            visibility until TikTok audits this app
Security:                   PASS (new RBAC re-check on the one new tool
                            that touches a write path; a structural
                            capability-matrix bug found and fixed before
                            it shipped)
Testing:                    PASS (61 new unit tests; full existing suite
                            green)
Documentation:              PASS
```

## 1. Audit findings (§1-4 of the brief)

TikTok's existing implementation was audited in full — OAuth
(`integrations/tiktok-oauth.ts`, PKCE + signed session-bound state), the
Display/Content-Posting API clients (`tiktok/{client,display-client,
resilient-client}.ts`, typed failure modes, retry/backoff), incremental
sync (`sync.ts`), derived metrics (`metrics.ts`), the grounded TikTok
Analyst Agent (`analyst.ts`), and — critically — **a real, already-audited
publish flow** (`publish.ts`: draft → explicit approval → submit via
`PULL_FROM_URL` → status poll → audit log, with a content-hash dedupe
guard re-checked at both draft-creation and submit time). Nothing found
was mocked or faked. `integrations/contract.ts`'s `TIKTOK` entry already
models `tiktok.get_analytics` as `NOT_AVAILABLE` (no such API endpoint)
and `tiktok.publish` as `REQUIRES_PROVIDER_APPROVAL` (TikTok app audit for
public visibility) — exactly the AVAILABLE/REQUIRES_APPROVAL/NOT_AVAILABLE
vocabulary the brief's §2 asks for, already in place before this phase.

**Conclusion**: the one concrete, load-bearing gap — identical in shape to
Phase 6's YouTube finding — was that the orchestrator's `tiktok-analyst`
capability calls `tiktok/*` functions directly, never through the Phase 5
Tool Registry / Policy Engine / Tool Executor. This became the phase's
central integration target.

## 2. TikTok capability matrix (§4)

`getTikTokCapabilityMatrix(organizationId)` — `packages/services/src/
tiktok/capability-matrix.ts` — reports 12 named capabilities every time,
using a richer `{level: READ_ONLY|WRITE|PUBLISH|DELETE, availability:
AVAILABLE|REQUIRES_APPROVAL|NOT_AVAILABLE}` shape (the brief's own §2/§4
vocabulary) rather than YouTube's simpler boolean. Full table in
`docs/TIKTOK-GROWTH-AGENT.md` §2. **A real bug found and fixed**:
`tiktok.publish`'s contract-resolved `.usable` flag is structurally always
`false` (§9 below) — the first draft of this matrix's `CONTENT_DRAFT`/
`CONTENT_PUBLISH` resolution incorrectly relied on it and was fixed to
check the connection's granted scope directly. 6 tests.

## 3. OAuth security (§6)

Unchanged, re-verified by audit: signed + session-bound state
(`integrations/state.ts`), PKCE (S256), an HttpOnly `tt_pkce` cookie
scoped to the callback path, encrypted token storage (AES-256-GCM),
refresh via the shared `ProviderOAuth` registry, and typed OAuth errors
(`TikTokAuthExpiredError`/`TikTokPermissionError`/`TikTokRateLimitError`)
that never leak raw provider error bodies. No changes made this phase.

## 4. Normalized data model (§7)

Existing models (`TikTokAccount`, `TikTokVideo`, `TikTokMetric`,
`TikTokSyncRun`, `TikTokPublish`) are unchanged. Three new models, additive
migration `20260926120000_tiktok_growth_agent`: `TikTokOpportunity`,
`TikTokExperiment`, `TikTokContentPlan`. Five brief-named models
deliberately **not** created because an equivalent already exists —
`TikTokProfile` (→ `TikTokAccount`), `TikTokVideoAnalytics` (→
`TikTokVideo` + `TikTokMetric`), `TikTokAudienceSnapshot` (no data source
exists — would be permanently empty or an invitation to fabricate),
`TikTokRecommendation` (→ the generic `Recommendation` model,
`domain: 'TIKTOK'`), `TikTokApiEvent` (→ `TikTokSyncRun.error` + audit +
`IntegrationHealth`). `TikTokContentPattern` is not persisted either
(recomputed on demand, matching the YouTube precedent).

## 5. Synchronization (§8)

Unchanged, re-verified by audit: incremental video sync (cursor on
`lastVideoCreateTime`), `TikTokSyncRun` bookkeeping
(RUNNING/COMPLETED/FAILED/SKIPPED), exponential backoff + retry in the
Display client, and a deliberate skip (not fabrication) of videos missing
`create_time`. No changes made this phase.

## 6. Analytics engine and formulas (§9-10)

`engagementRate`/`postingCadence`/`performerSplit`/`themeClusters`
(`metrics.ts`) are pre-existing and unchanged; each formula is already
labelled in the UI. New this phase: per-video **benchmarking**
(`benchmark.ts`) against the account's own duration-bucket median (short
≤60s / extended >60s — a real, meaningful TikTok distinction now that
videos can run several minutes), with documented ≥1.5×/≤0.5× thresholds
and a 5-video minimum peer count. 9 tests.

## 7. TikTok Growth Health / Evidence Engine (§11-12)

Reused, not rebuilt: the existing evidence-item shape
(`{statement, kind: fact|calculated_metric|assumption}`) and the shared
grounding-check discipline (`tiktok/grounding.ts`) already implement the
Observation → Evidence → Interpretation → Recommendation → Confidence
chain for the Analyst Agent's output. The new opportunity engine
(§9 below) follows the identical evidence shape for its own output.

## 8. Video analysis / content pattern detection (§13-14)

`detectContentPatterns` (`patterns.ts`) composes hashtag-cluster detection
(reusing the existing `themeClusters`) and a short-vs-extended duration
split (≥5 videos of each bucket, ≥1.2× ratio). Every observation is
phrased as a measured relationship — a dedicated test asserts no pattern
text contains "causes." 7 tests.

## 9. Content opportunity engine (§15)

`buildOpportunityDrafts` (`opportunities.ts`) — the identical four-factor
weighted PRIORITY SCORE formula as YouTube's
(`0.35·evidenceStrength + 0.25·historicalPerformance + 0.25·contentGap +
0.15·executionFeasibility`), `audienceRelevance` omitted for lack of real
data. Five of seven `TikTokOpportunityType` values produced; two reserved
(`AUDIENCE_OPPORTUNITY`, `TREND_OPPORTUNITY` — no data source). 6 tests,
including a dedicated no-guarantee/no-virality assertion.

## 10. Content idea/hook/caption/hashtag/script/brief generators (§16-21)

**Not duplicated.** The Content Repurposing engine already generates
`TIKTOK_IDEA` and `TIKTOK_CAPTION` deliverables (plus generic `SCRIPT`/
`HOOK` types) from a synced TikTok video (`content/generate.ts`,
pre-existing). Building a second, TikTok-specific generation path would
violate hard rule 9 (duplicate business logic). This is a disclosed,
deliberate scope decision, not an oversight — see
`docs/TIKTOK-GROWTH-AGENT.md` §9.

## 11. Content calendar (§22)

`generateContentPlanDrafts` (`calendar.ts`) — identical cycling/placeholder
logic to YouTube's calendar generator, persisted as `TikTokContentPlan`
(named to match this phase's own brief). 6 tests.

## 12. Experiment system (§23)

`evaluateExperiment` (`experiments.ts`) — identical 15%-meaningful-change
floor and confidence-bucketing logic to YouTube's. 8 tests.

## 13. TikTok AI tools / agent permissions (§24-25)

`agent/tiktok-tools.ts` — ten tools as a closed allowlist dispatched
through the existing `executeAgentTool` (Phase 5), each capability-gated
via `assertCapabilityUsable`. Full table with capability gates in
`docs/TIKTOK-GROWTH-AGENT.md` §9. `tool-executor.ts` gained one new
`'tiktok'` kind; `tool-registry.ts`'s catalogue gained the ten tools'
metadata (nine `LOW` risk `READ`/`ANALYSIS`/`GENERATION`; one `MEDIUM`
risk `ACTION` for the publish-draft tool). 7 tests
(`tiktok-tools.test.ts`).

## 14. Publishing safety (§26)

The existing `publish.ts` flow already implements the brief's exact
Draft → Validation → Policy check → User review → Approval → Publish →
Verify → Audit log sequence, unchanged. This phase's one addition,
`tiktok.content.publish.draft`, only ever performs the first step (create
an `AWAITING_APPROVAL` draft) — it structurally cannot submit, since
`approveAndSubmit` requires `approve: true`, which only the UI's "Approve
& publish" button supplies. The tool re-derives the caller's
`publish:external` permission from the database at call time
(`assertJobAuthorized`), since the `agent:run` permission that lets any
MEMBER use the agent at all does not imply publish rights. A dedicated
test (connected account + `video.publish` scope + a MEMBER-role caller)
confirms the refusal.

## 15. TikTok Command Center / Overview / Copilot (§27-29)

The existing 6-tab `/app/tiktok/*` workspace (Overview, Videos,
Performance, Opportunities, Recommendations, Publishing) is unchanged in
navigation shape; this phase added two tabs (Calendar, Experiments) and
extended two existing pages (Opportunities gained a real priority-scored
section; Performance gained a benchmark section). All real, connected
data — no fabricated numbers anywhere; every page's existing
`TikTokEmpty` gating for the not-connected/not-synced states is
untouched. The AI Copilot's TikTok understanding is unchanged this phase
(the existing `tiktok-analyst` capability); the new `tiktok-growth`
capability adds content-opportunity-specific routing (§16 below).

## 16. Orchestrator wiring (§25, "use the existing architecture")

A new `tiktok-growth` capability (`agent/capabilities.ts`) is the one
TikTok capability that dispatches through `executeAgentTool` instead of
calling a `tiktok/*` function directly, mirroring `youtube-growth` from
Phase 6 exactly. It runs `tiktok.content.performance`,
`tiktok.content.patterns`, and `tiktok.content.opportunities`
(`regenerate: true`) concurrently and degrades to `needs_prerequisite`
— never a crash, never fabricated data — when TikTok is disconnected or
every tool call fails. `tiktok-analyst` is untouched. The keyword router
(`planner.ts`) gained a matching pattern set. 3 tests
(`capabilities.test.ts`, mocking `executeAgentTool`).

## 17. Cross-platform intelligence / user brand memory (§30-31)

Not extended this phase, per the brief's own explicit scope limit ("only
implement TikTok-side integration with existing cross-platform context" /
"do not implement the full cross-platform autonomous system yet"). The
pre-existing cross-platform repurposing capability (YouTube video → TikTok
brief) and the shared `OrgMemory` architecture are unchanged and already
available to any capability, TikTok's new one included, without further
wiring.

## 18. Reporting (§32)

`reports/facts.ts`'s `gatherTikTok` extended, additively, with an
"open content opportunities" metric + top-5 `ReportOpportunity` rows, a
"completed experiments" metric with the supported/not-supported split,
and a running-experiments note. No new report type — the existing
seven-section, seven-type reporting engine already covers `TIKTOK`.

## 19. Background monitoring / anomaly detection (§33-34)

`automation/dispatch.ts`'s existing `TIKTOK_ANALYSIS` task now also runs
`detectAccountAnomalies` after the analyst run and notifies via the
existing notifications module on any detected anomaly (idempotent on
`dedupeKey`). **Anomaly detection could not reuse YouTube's
trailing-calendar-day baseline** — TikTok's `TikTokMetric` is an
irregularly-spaced snapshot table, never daily. `detectAccountAnomalies`
instead computes per-day growth _rates_ between consecutive snapshots
(`Δvalue / elapsed days`, dropping pairs closer than half a day apart) and
z-scores that normalized series, using the same 2.5σ/4σ thresholds. 7
tests, including one confirming a near-duplicate snapshot pair is
correctly dropped rather than producing a spurious anomaly. No new
scheduler — the existing automation/worker framework runs this.

## 20. API resilience / data freshness (§35-36)

Unchanged, re-verified by audit: timeouts, retry with backoff, rate-limit
handling, and structured typed errors already exist in the Display/
Content-Posting clients (`resilient-client.ts`). Every TikTok dashboard
page already surfaces `lastSyncedAt`/connection health via the existing
`loadTikTokState` helper — not modified this phase beyond the two new
pages reusing it identically.

## 21. Security (§37)

- Tenant isolation: every new query is organization-scoped; `scripts/
check-tenant-scope.mjs` passes.
- RBAC: the one new write-adjacent tool (`tiktok.content.publish.draft`)
  re-checks `publish:external` from the database at call time rather than
  trusting that `agent:run` implies it — see §14.
- **A real structural bug found and fixed**: `tiktok.publish`'s
  `.usable` flag is always `false` by design
  (`resolveCapabilities` never promotes `REQUIRES_PROVIDER_APPROVAL` to
  `AVAILABLE`), so the first draft of the capability matrix and the
  publish tool both incorrectly gated on it. Fixed before any commit —
  see ADR-0057 for the full writeup.
- Untrusted content: TikTok captions/hashtags were already wrapped via
  `wrapUntrusted('TIKTOK_VIDEO_METADATA', ...)` before this phase
  (Phase 22); unchanged.
- No secrets logged; no token exposed to the client — unchanged,
  re-verified by audit.

## 22. Observability (§38)

Unchanged infrastructure (pino structured logging, `TikTokSyncRun`/
`IntegrationHealth`/audit log) now also covers the new tool calls via the
existing, unmodified `executeAgentTool` instrumentation (rate-limit
events, `TOOL_CALLS` usage metering, `AgentRunEvent` timeline) — nothing
new was built, the existing uniform instrumentation simply now applies to
`tiktok.*` tool names too.

## 23. Database (§39)

See §4. Indexes: `(organizationId, status, priorityScore)` and
`(tikTokAccountId)` on `TikTokOpportunity`; `(organizationId, status)` and
`(tikTokAccountId)` on `TikTokExperiment`; `(organizationId,
scheduledDate)` and `(tikTokAccountId)` on `TikTokContentPlan` — mirroring
the exact index shape of the equivalent YouTube tables.

## 24. Testing (§40)

61 new unit tests across 9 new/extended test files: `capability-matrix
.test.ts` (6), `benchmark.test.ts` (9), `patterns.test.ts` (7),
`opportunities.test.ts` (6), `experiments.test.ts` (8),
`calendar.test.ts` (6), `monitoring.test.ts` (7), `tiktok-tools.test.ts`
(7 — extended with the RBAC re-check test — 8 total), `capabilities.test
.ts` (extended, +3), `dispatch.test.ts` (extended, +1), `tool-registry
.test.ts` (updated closed-list assertion). **`packages/services` test
count: 1161 (+61 since the pre-Phase-7 baseline of 1100 at the end of
Phase 6).** No integration or E2E tests were added — no live TikTok
credentials exist in this sandbox to exercise OAuth/API/publish
end-to-end (§26 below); the E2E scenario the brief describes (§40 "connect
→ callback → sync → analytics → opportunity → idea → brief → approval →
publishing capability check") is verified piecewise: each step's unit
tests pass, and the capability-gating/RBAC tests specifically verify that
an unauthorized or unavailable action is correctly blocked with the real
reason, matching the brief's own fallback instruction ("if publishing is
unavailable in the test environment, verify that the system correctly
blocks the action and explains why").

## 25. No mock production data (§41)

Confirmed by code review: every new UI section reads from real,
persisted `TikTokOpportunity`/`TikTokContentPlan`/`TikTokExperiment` rows
or the existing real `TikTokVideo`/`TikTokAccount` data; the empty states
(`TikTokEmpty`, `EmptyState`) are the only thing shown with no connection
or no data, never a placeholder number.

## 26. Production acceptance test (§46) — what was and wasn't verified

| Test                                                             | Result                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `/app/tiktok` shows a professional workspace                  | **Verified by build + typecheck + lint**, not a live click-through (no Docker/live org in this sandbox — same limitation as every prior TikTok/YouTube phase)                                                                     |
| 2-6. Connect → OAuth → account/video sync → real API data        | **Not verified live** — no TikTok developer credentials exist in this sandbox                                                                                                                                                     |
| 7. Analytics calculated correctly                                | **Verified** — unit tests against hand-built fixtures for every formula                                                                                                                                                           |
| 8. AI explains performance using evidence                        | **Verified** — existing grounding-check tests, unchanged                                                                                                                                                                          |
| 9. AI generates account-specific content ideas                   | **Verified** — existing Content Repurposing engine tests, unchanged; new opportunity-engine tests                                                                                                                                 |
| 10. AI generates hooks/captions/hashtags/scripts/briefs          | **Pre-existing, unchanged** — Content Repurposing engine (`TIKTOK_IDEA`/`TIKTOK_CAPTION`/`SCRIPT`/`HOOK`)                                                                                                                         |
| 11. User can create an experiment                                | **Verified** — `experiments.test.ts` + the new `/app/tiktok/experiments` page, build-verified                                                                                                                                     |
| 12. System generates a weekly report                             | **Verified indirectly** — `gatherTikTok` extension covered by the existing reporting-engine test suite's fixture pattern; no dedicated `facts.test.ts` exists for any report type (a pre-existing gap, not introduced this phase) |
| 13. Background sync works                                        | **Pre-existing, unchanged**, re-verified by audit                                                                                                                                                                                 |
| 14. Connection failures are detected and displayed               | **Pre-existing, unchanged** (`TikTokEmpty`, `connection_error` state)                                                                                                                                                             |
| 15. Unavailable capabilities are clearly identified              | **Verified** — `capability-matrix.test.ts`, 6 tests                                                                                                                                                                               |
| 16. AI cannot perform unauthorized actions                       | **Verified** — the RBAC re-check test is the direct proof for the one tool that could otherwise escalate                                                                                                                          |
| 17. Publishing requires the correct capability and approval flow | **Verified** — pre-existing `publish.ts` flow (unchanged) + the new tool's re-derived RBAC check                                                                                                                                  |
| 18. Sensitive credentials remain protected                       | **Verified by code review** — no new credential handling was added                                                                                                                                                                |
| 19. Tenant isolation passes                                      | **Verified** — `scripts/check-tenant-scope.mjs` passes                                                                                                                                                                            |
| 20. E2E tests pass                                               | **Not run** — no E2E tests were added this phase (see §24); the full existing test suite (1161 unit tests, format/lint/typecheck across all 8 packages) passes                                                                    |

## Files changed

- New: `packages/services/src/tiktok/{capability-matrix,benchmark,patterns,
opportunities,experiments,calendar,monitoring}.ts` + matching `.test.ts`
  files.
- New: `packages/services/src/agent/tiktok-tools.ts` + `.test.ts`.
- New: `packages/db/prisma/migrations/20260926120000_tiktok_growth_agent/
migration.sql`.
- New: `apps/web/app/(app)/app/tiktok/{calendar,experiments}/page.tsx`.
- New: `docs/TIKTOK-GROWTH-AGENT.md`, `docs/PHASE-7-REPORT.md`.
- Modified: `packages/db/prisma/schema.prisma`; `packages/services/src/
{tiktok/index,agent/{index,tool-executor,tool-registry,tool-registry.test,
schemas,planner,capabilities,capabilities.test},reports/facts,automation/
{dispatch,dispatch.test}}.ts`; `apps/web/app/(app)/app/tiktok/
{opportunities,performance}/page.tsx`; `apps/web/src/{server/tiktok-actions
.ts,components/app/tiktok/{tiktok-actions,tiktok-tabs}.tsx}`;
  `docs/{DECISIONS.md,TIKTOK-INTEGRATION.md}`; `CLAUDE.md`.

## Database changes

One additive migration: 5 new enums, 3 new tables
(`TikTokOpportunity`, `TikTokExperiment`, `TikTokContentPlan`) — see §4/§23.

## API integrations

No new TikTok API endpoint calls were added. All new functionality reads
already-synced database rows or reuses the existing `createPublishDraft`
function; the underlying Display API (`/user/info/`, `/video/list/`) and
Content Posting API (`/post/publish/video/init/`,
`/post/publish/status/fetch/`) calls are unchanged from the pre-existing
integration.

## Environment variables

None added. `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`/`ENCRYPTION_KEY`
(pre-existing) are the only variables this phase's tests needed to stub.

## Known limitations

- No live TikTok API verification anywhere in this phase (no developer
  credentials in this sandbox) — same disclosed limitation as every prior
  TikTok-touching phase.
- `CONTENT_ANALYTICS_READ` and `AUDIENCE_ANALYTICS_READ` are permanently
  `NOT_AVAILABLE` — genuine TikTok public-API absences, not gaps this
  phase could close.
- No E2E test coverage was added for the new UI pages (see §24).
- `TikTokContentPattern` is not persisted (recomputed on demand) — if a
  future phase needs historical pattern tracking, this would need a new
  model.
- Anomaly detection's rate-based approach has not been validated against
  real, irregularly-spaced production sync data — only synthetic
  fixtures.

## TikTok approval requirements

- **Public-visibility publishing** (`PUBLIC_TO_EVERYONE`/`MUTUAL_FOLLOW_FRIENDS`/
  `FOLLOWER_OF_CREATOR` privacy levels) requires TikTok to audit this
  application. Until that audit passes, only `SELF_ONLY` posts can
  succeed — this was true before this phase and is unchanged; the new
  `tiktok.content.publish.draft` agent tool inherits this exact
  limitation via the existing `publish.ts` flow it calls.
- No other capability in this phase requires additional TikTok approval —
  everything else operates on already-granted scopes or already-synced
  data.

## Production deployment requirements

None beyond what `docs/TIKTOK-INTEGRATION.md` already documents
(`TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`, the redirect URI registered
in the TikTok developer portal, and — for public posting — a passed
TikTok app audit). No new environment variable, service, or
infrastructure requirement was introduced by this phase.

## Recommended next phase

Per the brief's own stop condition (§50), no Phase 8 work was started.
If authorized, natural next steps mirror Phase 6's own "Recommended Phase
7" note: apply the same "one capability calls `executeAgentTool`" pattern
to the SEO domain (the one remaining domain still using direct function
calls); consider live-account verification once real TikTok/YouTube
developer credentials become available; and, if cross-platform
intelligence is prioritized, build the explicit YouTube↔TikTok adaptation
-opportunity detection the brief's §30 sketches (deliberately deferred
this phase, per its own scope limit).

---

**END PHASE 7.** No Phase 8, WordPress, SEO, Google Search Console,
enterprise billing, unrelated UI, new AI model infrastructure, or
unrelated database refactoring was started, per the brief's explicit stop
condition (§47/§50).
