# GROWTH-MISSIONS.md — Growth Missions & cross-platform orchestration (Phase 10)

Status: **implemented**. Code: `packages/services/src/missions/*`,
`apps/worker/src/processors/agent.ts` (reactivated `agent-run` queue),
`apps/web/app/(app)/app/missions/*`, `apps/web/src/server/mission-actions.ts`,
`apps/web/app/api/missions/*`. Decision record: ADR-0059.

A Growth Mission turns a user-defined goal ("grow my organic traffic") into a
plan the AI works through across YouTube/TikTok/SEO/WordPress — bounded, at
every step, by the SAME security/RBAC/approval/audit/tenant-isolation systems
every other feature in this app already uses. There is no separate
"autonomous agent" security model; autonomy only ever widens which
*unattended, already-safe* steps the background sweep may attempt on its
own, never what is safe to do at all.

---

## 1. Audit findings (mandatory first step)

Before writing code, the existing systems this phase must plug into were
read in full: the Phase 4 agent runtime (`AgentRun`/`AgentRunEvent`, the
turn loop, cancellation, the idle `agent-run` queue), the Phase 5 Tool
Registry/Policy Engine/Tool Executor, the Phase 1 approval queue
(`IntegrationActionRequest`, `EXECUTORS`, `decideActionRequest`), the flat
`Task` model, `AutomationRule`/`AutomationRun` + `dispatchTask`'s owner
-recheck/retry/backoff/escalation pattern, `OrgMemory`, `Notification`,
`recordAudit`, AI governance, and RBAC. Key findings that shaped the
design:

- **The approval floor is already absolute and impossible to weaken from a
  tool call.** Every WRITE/PUBLISH-shaped tool across YouTube/TikTok/
  WordPress (`*-tools.ts`, Phase 6-9) is built so its own effect is *only*
  to file a pending `IntegrationActionRequest` — it never executes
  directly. This means a mission's automation cannot violate hard rule 4
  even if this phase's own policy code had a bug: the floor lives one
  layer below, in code already audited across three prior phases.
- **The `agent-run` BullMQ queue was fully built and registered, but
  nothing had ever called `.add()` on it** (`docs/AGENT-RUNTIME.md` §8,
  confirmed by repo-wide grep) — the natural, already-idle home for
  mission background execution, rather than a new queue.
- **No `Mission` model exists anywhere** (confirmed by grep); the existing
  `/app/missions` page is an explicitly-labelled "presentational
  aggregation" (Phase 3) with no persisted entity behind it.
- **`Task` is a flat checklist item** with no dependency/parent-child
  support — a genuinely different shape from what a dependency-aware task
  graph needs, so a new `MissionTask` model is not a duplicate of it (a
  completed `MissionTask`'s human-facing follow-through still opens a real
  `Task`, reusing `createTask` unchanged).
- **A real, pre-existing bug found in passing**: `governance/index.ts`
  maintained its own duplicate `AUTOMATION_TASK_TYPES` list that was never
  updated when Phase 9 added `WORDPRESS_CONTENT_REFRESH` to the real one in
  `automation/schemas.ts` — every org on default governance settings was
  silently blocked from ever creating that automation. Fixed by having
  governance import the one real list instead of maintaining a second.

---

## 2. What "autonomy" means here, precisely

Four levels, no more (§5: "do not introduce a higher level than
necessary"), each a real, tested pure function
(`missions/policy.ts::evaluateMissionPolicy`):

| Level | May attempt | Auto-runs in the background sweep |
| --- | --- | --- |
| `ADVISORY` | LOW-risk (read/analyze) tasks only | LOW-risk only |
| `ASSISTED` | LOW + MEDIUM-risk (e.g. a safe DRAFT-level tool) | LOW-risk only — MEDIUM needs an explicit human "run now" |
| `SUPERVISED` | LOW + MEDIUM | LOW-risk only — MEDIUM still needs an explicit trigger |
| `CONTROLLED` | LOW + MEDIUM | LOW **and** MEDIUM — a pre-approved action class |

**HIGH/CRITICAL risk (publish, delete, anything the existing tool registry
classifies that way) is never auto-executable at any level** — and,
independently of this table, every such tool's real effect is *already*
gated behind `IntegrationActionRequest` regardless of what this table says
(§1's key finding). The autonomy level therefore only ever controls one
thing: **whether the unattended sweep may attempt a LOW/MEDIUM-risk step
without a human clicking "run" first.** It never controls whether an
external system can actually be changed without approval — that floor is
constant across every level.

`lookupToolRisk` reads the SAME `riskLevel` the Phase 5 Tool Registry
already assigns each tool (`LOW|MEDIUM|HIGH|CRITICAL`, derived from its
real `CapabilityLevel`) — never a second, parallel classification.

---

## 3. The mission model

`GrowthMission` carries the fields the brief asks for (§4), with
`budget`/`constraints`/`limits`/`approvalPolicy`/`successMetrics`/
`currentStrategy`/`currentProgress` as Zod-validated JSON
(`missions/schemas.ts`) rather than their own tables — one mission has
exactly one of each, so a relational table would add no query capability
this phase actually needs (mirrors `AiGovernancePolicy.policy`'s existing
precedent). `MissionLimits` has a hard ceiling (`LIMIT_CEILINGS`) a
mission's own config can never exceed — a compromised planning prompt or a
careless user cannot ask the mission to remove its own leash.

**Statuses** (§4): `DRAFT → PLANNING → AWAITING_APPROVAL → ACTIVE ⇄ PAUSED`,
terminal `COMPLETED | FAILED | CANCELLED`, plus `BLOCKED` for a resource
-limit/owner-permission/integration-disconnection stop that a human can
resolve and the mission can then resume from (`PAUSED`) — vs. a graph that
terminated with a real task failure, which is `FAILED`, never silently
reported as `COMPLETED`.

### Named models the brief lists that were deliberately not created

Per hard rule 9 ("do not duplicate business logic") and the brief's own
§44 instruction ("do not create duplicate task/approval/event systems if
equivalent existing models can be extended"):

- **`MissionDependency`** — a join table would add no capability beyond a
  plain `dependsOnTaskIds: String[]` column on `MissionTask`, which
  `missions/task-graph.ts`'s pure readiness functions already resolve in
  full (including cascading blocks and cycle detection).
- **`MissionAction`** — every actual external action a mission task takes
  either goes through `executeAgentTool` (metered/authorized/timelined by
  the existing Phase 5 stack) or, for a WRITE/PUBLISH-shaped one, files a
  real `IntegrationActionRequest` (extended with a `sourceMissionTaskId`
  provenance FK, mirroring Phase 9's `sourceCrawlIssueId` exactly). There
  is no "action" concept independent of one of these two existing paths.
- **`MissionApproval`** — reuses `IntegrationActionRequest` in full (see
  above); the one non-tool approval gate, activating a reviewed plan
  (§48), is a direct, explicit user action (`activateMission`), not
  something the AI proposes and a human approves through a queue.
- **`MissionExecution`** — a mission's execution trace is its
  `MissionEvent` rows (one per real transition, mirroring
  `AgentRunEvent`'s exact design) plus, for the rare model-driven
  operation (the plan's strategy narrative, a daily brief), a real
  `AgentRun` row (`AgentRun.missionId`, a new nullable FK) — reusing the
  Phase 4 runtime's own cost/token tracking rather than inventing a
  parallel one.
- **`MissionBudget` / `MissionConstraint`** — JSON fields on
  `GrowthMission` (see above); each mission has exactly one of each.

### What genuinely is new schema

`GrowthMission`, `MissionMilestone`, `MissionTask`, `MissionMetric`,
`MissionLearning`, `MissionEvent` — six new tables, none of them
duplicating an existing concept. `MissionLearning` deserves its own
explanation: `OrgMemory` (Phase 7) already exists for cross-turn goals/
preferences, but its `value` field is free prose, not the brief's explicit
Observation/Hypothesis/Learning/Decision typed distinction (§19) with
per-entry confidence and evidence — a genuinely different shape serving a
different reader (a mission's weekly review vs. the chat agent's working
memory), so it is not a duplicate.

Migration `20260928120000_growth_missions` is fully additive (6 new
tables, 3 new nullable FK columns on existing tables, 0 drops) — verified
statement-for-statement equal to `prisma migrate diff`'s own generated SQL.

---

## 4. The planner — evidence-based, never fabricated

`missions/planner.ts::generateMissionPlan` builds milestones/tasks **only**
from real signals in `agent/context.ts`'s `OrgContext` (the same snapshot
the chat agent already uses) plus a couple of targeted follow-up reads
(`findRefreshCandidates`, `listWebsites`). A platform the mission allows
but the organization has not connected gets an honest assumption
("connect it to include it in this mission"), never a fabricated task —
confirmed by a dedicated test asserting an all-disconnected mission plans
zero tasks and says so in its risks. The generated task graph is checked
for cycles (`hasCycle`) before it is persisted — a defensive check against
a planner bug, not something the deterministic generator should ever
produce given its purely-forward dependency edges.

An optional grounded `generateObject` pass (`refineNarrative`) refines only
the prose narrative/current-state/target-state text — every milestone,
task, and dependency edge is deterministic and unaffected by the model,
dropped entirely on any grounding failure (the same "numbers never depend
on the model" discipline every prior phase's planner/synthesis step uses).

---

## 5. Delegation — reusing every existing platform surface

`missions/delegation.ts::delegateMissionTask` never reimplements
authorization. For a `toolName` under `youtube.*`/`tiktok.*`/
`wordpress.*`, it dispatches through the existing `executeAgentTool`
(Phase 5) unchanged — full rate-limit/usage-meter/authorization/timeline
stack for free. For the two SEO operations
(`seo.crawl.start`/`seo.agent.analyze`) — SEO remains the one domain not
yet wired into the Tool Executor (`docs/AGENTS.md`'s disclosed gap,
unchanged by this phase) — delegation calls the exact same tenant-scoped
functions (`seo.startCrawl`, `seo.runSeoAgent`) `automation/dispatch.ts`
already calls safely for `WEBSITE_CRAWL`. A `toolName: null` task is a pure
human-decision point: it opens a real `Task` (`sourceMissionTaskId`
linked) and is done — the human's follow-through is tracked on the
existing Tasks board, exactly like automation's `CONTENT_OPPORTUNITY`/
`SEO_ISSUE_ALERT` tasks already work.

**A subtlety this phase had to get right**: a propose-only ACTION tool
(`wordpress.content.update.propose`, etc.) returns `SUCCESS` from
`executeAgentTool`'s point of view the moment it successfully *files* the
approval request — that is not the same as the underlying WordPress action
having happened. `delegation.ts` detects this (`category === 'ACTION' &&
requiresApproval === true` from the same Tool Registry metadata, plus a
duck-typed check that the returned data really is a pending
`IntegrationActionRequest` row) and reports `requires_approval`, not `ok`,
so the loop correctly parks the `MissionTask` in `WAITING_APPROVAL` rather
than prematurely marking it `SUCCEEDED` before a human has approved
anything.

---

## 6. The execution loop

`missions/loop.ts::runMissionTick` — one bounded step per call: recompute
task readiness → check stop conditions → pick the next `READY` task whose
policy decision is `permitted && autoExecutable` → delegate it → record
the result (`SUCCEEDED`/`WAITING_APPROVAL`/`READY`-retry-or-`FAILED`) →
update the mission's counters. Mirrors `automation/runner.ts::
executeAutomationRun`'s own "bounded, inline, one unit of work per call"
design exactly, including its owner-RBAC-recheck-blocks-the-whole-thing
pattern (`assertMissionOwnerMay` re-derived from the database every tick,
never trusted from when the mission was created).

`runMissionTaskManually` is the explicit, human-triggered counterpart
(§54) — it ignores `autoExecutable` (a human is explicitly asking) but
still enforces `permitted` (a mission boundary can never be bypassed by
asking a different way) and the same concurrency guard.

### Stop conditions (§21)

`missions/stop-conditions.ts::evaluateStopConditions` — a pure function
over a real snapshot (deadline, budget, tool-call/task-count limits, a
consecutive loop-failure counter, whether every success metric is met,
whether a used platform disconnected). `GOAL_ACHIEVED`/`DEADLINE_REACHED`
complete the mission; every other reason `BLOCK`s it (resumable once the
human fixes the cause) rather than cancelling it outright. A graph that
terminates with a real task failure (not just running out of tasks) is
reported `FAILED`, never `COMPLETED` — a real bug this phase's own test
suite caught before it shipped (see §9).

### Concurrency (§37/§38)

`missions/concurrency.ts::isResourceLocked` — a plain row check (no new
lock table, no Redis dependency) over `MissionTask.resourceKey`: two tasks
sharing a key, even across different missions, cannot both be RUNNING/
WAITING_APPROVAL at once. For the one real write target that exists today
(WordPress posts), Phase 9's `expectedContentHash` version guard is a
second, independent line of defense — a stale proposal is refused at
execution time regardless of what the concurrency check decided.

### Conflict detection (§35)

`missions/conflict.ts::detectPlatformOverlap` — deliberately narrow: it
flags the one conflict signal checkable as a plain fact (two ACTIVE
missions sharing a platform) without parsing free-text constraints (e.g.
"5 articles/week" vs. "2/week" is not mechanically comparable without
guessing intent). Activation is never blocked by a detected overlap — a
`CONFLICT_DETECTED` event + notification says "human decision required,"
per the brief's own instruction not to silently resolve it.

---

## 7. Approvals, notifications, and the human-visible surface

No new approval UI — `/app/integrations/approvals` already lists every
`IntegrationActionRequest`, mission-sourced or not, and its existing
`decideApprovalAction` Server Action is reused unchanged. The mission
detail page (`/app/missions/[missionId]`) additionally shows the subset
filed by *this* mission's tasks (`listMissionApprovals`), so a user
reviewing one mission doesn't have to cross-reference the global queue.

Notifications reuse the existing `Notification` model throughout: mission
activation, a detected conflict, the daily brief, and the weekly review
all go through `createNotification`, with `dedupeKey`s scoped by org+date/
week so a retried sweep tick can never duplicate one.

---

## 8. Daily brief and weekly review (§28/§29)

`missions/briefing.ts` gathers real facts from the same read functions the
reporting engine and automation dispatcher already use (channel/account
overviews, the latest crawl, WordPress refresh candidates, active
missions) — never a new data source. `buildWeeklyReview` keeps Facts /
Interpretations / Recommendations in three explicitly separate arrays,
never blending a fact with an inference. Delivery is a platform-wide sweep
(`orgsWorthBriefing` — orgs with at least one connected platform or an
active mission), mirroring `automation/runner.ts::dueAutomations`'s own
"tenant-scope-ok, scheduler sweep across all orgs" comment: there is no
single "acting user" for a scheduled cross-org digest, and the delivered
notification is itself org-wide.

**Disclosed, deliberate scope cut**: brief history is not persisted as its
own queryable model — each brief/review is computed fresh and delivered
via `Notification`. A future phase could add a `MissionBrief` table if a
"see last week's brief" view is wanted; this phase judged that a genuinely
separate feature from the mission execution engine itself.

---

## 9. A real bug this phase's own tests caught before shipping

Writing `loop.test.ts`'s "permanently blocks a task whose dependency
failed" case surfaced a real correctness bug in code written earlier in
this same phase: `runMissionTick`'s "graph complete" branch unconditionally
reported the mission `COMPLETED`/`GOAL_ACHIEVED`, even when the graph
terminated because a task `FAILED` and its dependents were permanently
`BLOCKED` — a mission whose only task failed would have been reported as a
success. Fixed by checking for any `FAILED`/`BLOCKED` task among the
terminal set and reporting `FAILED` instead, with a new `MissionTickResult`
outcome (`'failed'`) added specifically so the test could observe the
distinction. A second, related bug in `task-graph.ts` was caught by the
same test: `BLOCKED` was not included in `TERMINAL_NON_SUCCESS`, so a task
depending on an already-`BLOCKED` task (rather than directly on a `FAILED`
one) never cascaded to `BLOCKED` itself and would have sat in `PENDING`
limbo forever — fixed by treating `BLOCKED` as terminal-non-success
throughout (nothing in this codebase ever un-blocks a task, so this is
correct, not just convenient).

A third, narrower issue was found in the **test harness itself**
(`packages/services/src/testing/memory-db.ts`): its `orderBy` support only
ever read a single field, silently ignoring a real Prisma-style
multi-field array (`orderBy: [{a:'desc'},{b:'desc'}]`) — any code passing
one got no defined sort at all. Fixed by extending `sorted()` to support
both forms; `missions/metrics.ts` now orders by `measuredAt` then
`createdAt` as a tiebreaker for two measurements recorded within the same
millisecond (a real, if narrow, possibility this schema doesn't need a
dedicated sequence column to handle correctly in production, since real
metric syncs are practically always minutes to hours apart).

---

## 10. Security (§40/§41)

Nothing here is a new authorization model:

- **Instruction hierarchy** (§41) is unchanged and already enforced by
  `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` (Phase 22/25) — the planner's one
  model call (the strategy narrative) fences every piece of evidence with
  `wrapUntrusted`, exactly like every other model-facing prompt in this
  codebase.
- **Cross-tenant access**: every mission query is scoped by
  `organizationId` (verified by `scripts/check-tenant-scope.mjs`, which
  passed clean against all six new models) and by `check-tenant-scope`'s
  CI gate.
- **Privilege escalation / approval bypass**: structurally impossible from
  a mission task — see §1's key finding. A mission's `allowedActions`/
  `allowedPlatforms` can only ever narrow what the loop attempts, never
  widen the underlying tool/governance/approval authorization it still
  goes through.
- **Runaway execution**: `MissionLimits`' hard ceilings
  (`LIMIT_CEILINGS`), the per-mission `loopFailureCount` escalation
  (mirroring `AutomationRule.failureCount`'s 5/10 thresholds), and the
  one-task-per-tick bound together prevent an unbounded loop; a genuinely
  new adversarial red-team pass specific to mission execution was not run
  this phase (see Known limitations).

---

## 11. Testing

New test files: `task-graph.test.ts` (16), `policy.test.ts` (15),
`stop-conditions.test.ts` (14), `metrics.test.ts` (12), `conflict.test.ts`
(6), `crud.test.ts` (RBAC + full lifecycle + conflict flagging), and
`loop.test.ts` (owner-loss blocking, human-decision task execution,
readiness cascades, deadline/graph-completion stop conditions — including
the two real bugs in §9). All pure-logic modules are unit-tested against
hand-built fixtures; the CRUD/loop tests use the shared `createMemoryDb()`
harness (extended this phase with `youTubeChannel`/`tikTokAccount`/
`crawl`/`task`/`recommendation` stubs so `loadOrgContext` — a dependency of
the planner and the briefing module — can be exercised against an
all-disconnected org without throwing). **No live platform data or a real
Postgres instance was used** — the same disclosed limitation as every
prior phase in this sandbox.

---

## 12. What was deliberately not built (§56)

Matching the brief's own explicit "do not implement yet" list: no
autonomous financial spending (the `MissionBudget` architecture exists,
`spentUsd` is tracked, nothing ever increments it — no paid action exists
anywhere in this codebase to spend against), no autonomous advertising, no
autonomous account/security/permission changes, no unrestricted publishing
or deletion (every such action still requires human approval regardless
of autonomy level), no new AI model infrastructure, and no unrelated
integrations.

## 13. Known limitations, disclosed

- **No dedicated mission-specific adversarial/red-team test suite.** The
  existing `agents/ai-red-team.test.ts`/`adversarial.test.ts` cover the
  shared prompt-injection/instruction-hierarchy machinery this phase
  reuses unchanged, but no new test specifically attacks the mission loop
  (e.g. "can a crafted milestone description make the planner widen
  `allowedActions`?" — structurally no, since the planner never writes
  `allowedActions`, only the create-time input does, but this was not
  independently red-teamed this phase).
- **No wall-clock timeout on a single tick.** Like the Phase 4 turn loop
  before it, a tick that calls a slow tool has no `MAX_RUNTIME` of its
  own — it relies on the underlying tool's own timeout (`packages/ai`'s
  `withResilience`, the crawler's page-count cap, etc.).
- **Daily brief / weekly review have no per-org opt-out or custom
  schedule** — UTC-only fixed intervals, matching automation's own
  disclosed "UTC only" limitation.
- **No live verification.** No live YouTube/TikTok/WordPress/SEO data, and
  no real Postgres instance, was available in this sandbox — every new
  module was verified by unit/integration-style tests against hand-built
  fixtures and the shared in-memory DB harness only.
