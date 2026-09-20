# AGENT-RUNTIME.md — the AI agent execution engine (Phase 4)

Decision record: ADR-0054. Complements `docs/AI-ARCHITECTURE.md` (provider
layer, prompt-injection defenses, memory) and `docs/AGENTS.md` (per-agent
tool surfaces). This document covers what Phase 4 specifically added or
changed: the durable run/event model, cancellation, the formal tool
registry, real (but not yet wired-in) model tool-calling, configurable
approval expiration, dry-run mode, and the usage-metering fix.

Phase 4's own brief asked for an audit before coding. That audit
(`docs/PHASE-4-REPORT.md` §1) found that most of what the brief describes
already existed under different names — a real orchestrator loop, a mature
approval system, governance-based risk gating, tested prompt-injection
defenses. This document is written against that baseline: it says what's
new, and points at the existing docs for what isn't.

## 1. The turn loop, as it actually runs

```
USER MESSAGE
  → load/create conversation + last 20 messages (short-term memory)
  → create AgentRun (QUEUED semantics skipped — chat runs start RUNNING)
  → RUN_CREATED, RUN_STARTED events
  ↓
GATHERING   loadOrgContext + loadMemory, in parallel      → CONTEXT_LOADED
  ↓
PLANNING    keyword router, model-refined                 → PLAN_CREATED
  ↓ [cancellation checkpoint]
RUNNING     up to 5 capabilities, concurrently:
              TOOL_SELECTED → TOOL_AUTHORIZATION_CHECK (governance-gated
              capabilities only) → TOOL_STARTED → TOOL_COMPLETED | TOOL_FAILED
  ↓ [cancellation checkpoint]
SYNTHESIZING  generateObject → GrowthAgentResponse, grounding-checked,
              deterministic fallback on failure
  ↓
WRITING     streamText for the natural-language reply, token-by-token
  ↓
PERSIST     AIMessage, AgentRun → COMPLETED, memory update, audit
  → RUN_COMPLETED event
  ↓
STREAM TO USER (SSE, already in progress since PLANNING)
```

This is the same pipeline `docs/AI-ARCHITECTURE.md` already documented
(`packages/services/src/agent/orchestrator.ts`); Phase 4 did not rewrite it.
What's new is that every arrow above now also writes a durable
`AgentRunEvent` row (§3), and two of the checkpoints now also check for a
cancellation request (§4) before continuing — both additive to the existing
function, not a restructure of it.

## 2. What already existed, precisely

Documented once here so this file doesn't duplicate three other docs:

- **The approval system** (`packages/services/src/approvals/`,
  `IntegrationActionRequest`) already implemented the brief's "durable
  approval, no model reinterpretation" requirement almost exactly: a
  conditional `updateMany` claim makes approve/reject exactly-once, and
  `decideActionRequest` re-parses the **exact JSON payload captured at
  request time** through the same Zod schema before executing — there is no
  step where a model, or the human-readable summary, is consulted again.
  Phase 4 changed one thing here: the TTL is now configurable (§5).
- **Risk/permission model**: `CapabilityLevel` (READ/DRAFT/WRITE/PUBLISH/
  DANGEROUS, `packages/services/src/integrations/contract.ts`) and
  governance's `ActionClass` (analyze/generate/draft/modify/publish/delete,
  `packages/services/src/governance/index.ts`) already implement the
  brief's requested hierarchy and enforce it in code (the schema cannot even
  express "publish: automatic"). Phase 4's Tool Registry (§6) adds a
  `ToolRiskLevel` (LOW/MEDIUM/HIGH/CRITICAL) derived from `CapabilityLevel`,
  as a display/reasoning label — it does not replace or duplicate the real
  enforcement, which is unchanged.
- **Prompt-injection defense**: `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` +
  `wrapUntrusted` (Phase 22/25), already on every model-facing prompt in the
  agent layer. Unchanged.
- **Memory**: `OrgMemory` (6 kinds), already the long-term layer; per-turn
  `orgContext`/`memory` loading is the working-memory layer; the last 20
  messages are the short-term layer. Unchanged — see
  `docs/AI-ARCHITECTURE.md` §5 for the taxonomy.

## 3. Durable run timeline: `AgentRun` + `AgentRunEvent`

`AgentRun` (existing table) gained additive columns: `userId`,
`conversationId` (direct link, so a run can be queried without going
through `AIMessage`), `currentStep` (a cheap human-readable pointer —
`"gathering"`, `"running"`, `"synthesizing"`, `"writing"`, `"done"` — for a
still-RUNNING run without reading its event history), `iterationCount`,
`toolCallCount`, `errorCode`, `metadata`, `cancelledAt`, `updatedAt`.
`AgentRunStatus` gained `PAUSED` and `TIMED_OUT` (reserved — nothing emits
`TIMED_OUT` yet; see §8).

`AgentRunEvent` (new table, `packages/services/src/agent/events.ts`) is the
timeline the brief's Part 3 asked for: one row per real state transition,
`{agentRunId, organizationId, type, metadata, createdAt}`.
`recordAgentRunEvent` never throws into the caller (same convention as
`recordAudit`) and runs `metadata` through the same `scrubModelOutput`
secret-scrubber applied to model output — an event can never carry an OAuth
token, refresh token, password or API key.

**Verified live** against a real, isolated Postgres schema (never the
running staging app — see `docs/PHASE-4-REPORT.md` §14 for the method): one
real turn produced exactly `RUN_CREATED → RUN_STARTED → CONTEXT_LOADED →
PLAN_CREATED → TOOL_SELECTED (×2) → TOOL_AUTHORIZATION_CHECK (×1, only the
governance-gated capability) → TOOL_STARTED (×2) → TOOL_COMPLETED (×2) →
RUN_COMPLETED` — 12 rows in the correct causal order, with `userId`,
`conversationId`, `toolCallCount: 2`, `iterationCount: 1` all populated
correctly on the parent row.

**Not every event type in the brief's original vocabulary is emitted.**
`USER_INPUT_REQUESTED`/`USER_INPUT_RECEIVED` (no mid-run user-input pause
exists — a turn runs to completion or is cancelled, it never asks a
clarifying question mid-flight), `RETRY_STARTED` (no automatic retry loop
exists in the orchestrator itself — see §9), `RUN_PAUSED`/`RUN_RESUMED` (no
generic pause/resume exists — `PAUSED` is a reserved status, not a live
one), `MODEL_CALLED`/`MODEL_RESPONSE` (the orchestrator's own two direct
model calls — synthesis and writing — are covered by the `synthesizing`/
`writing` stage boundaries already; adding a redundant event pair for them
was judged not worth the extra write). `APPROVAL_REQUESTED`/`GRANTED`/
`REJECTED` are reserved for when a capability's tool surface can actually
trigger an approval mid-turn (§6 — today `integrations.propose_action`
exists but isn't wired into any live capability). The enum keeps all of
these values so a future phase can start emitting them without a schema
change — this file is the place that says which ones are live today.

### API

- `GET /api/agent/runs/:agentRunId` — current status (`getAgentRun`).
- `GET /api/agent/runs/:agentRunId/events` — the full timeline
  (`listAgentRunEvents`), independent of the live SSE stream — this is what
  lets a run's history survive a page reload or an SSE reconnect, which the
  ephemeral live stream alone cannot do.

Both are tenant-scoped from the session's `organizationId`, never from the
URL or a client-supplied value beyond the run id itself.

## 4. Cancellation

**Before Phase 4, an interactive chat turn could not be cancelled at all**
once started — confirmed by audit, not assumed (no `cancel` function
existed for `AgentRun`/`AIConversation`, the stream route never read
`req.signal`, `streamGrowthAgentTurn` accepted no abort signal). Two
independent mechanisms now exist, deliberately not one big rewrite of the
orchestrator's control flow:

1. **Checkpoint-based, explicit cancellation** (`cancelAgentRun`,
   `packages/services/src/agent/cancellation.ts`): `POST /api/agent/runs/
:agentRunId/cancel` does a conditional `updateMany` — `status: {in:
[QUEUED, RUNNING]} → CANCELLED` — the same exactly-once pattern
   `decideActionRequest` already uses for approvals. The orchestrator polls
   this status **between stages** (after planning, after the capability
   batch) via `checkCancelled`, and its own final "mark COMPLETED" write is
   itself a conditional `updateMany` that refuses to override an
   already-CANCELLED row. This is a deliberate design choice: cancellation
   never interrupts a capability or a model call already in flight — it
   only stops the **next** stage from starting, which is what "never
   terminate halfway through a critical database transaction" (Part 20)
   actually requires. A capability that was already running when Stop was
   clicked finishes normally; its result is simply never synthesized into a
   response, because the turn stops at the next checkpoint instead.
2. **Client-disconnect abort** (`RunTurnOptions.signal`): the stream route
   passes the incoming HTTP request's `AbortSignal` all the way into the
   orchestrator's own two direct model calls (`synthesize`'s
   `generateObject`, the final `streamText`) via `packages/ai`'s existing
   `GenerateTextOptions.signal` field — this was already wired into the
   Vercel AI SDK adapter before Phase 4, it just wasn't threaded from the
   route. A closed tab or an aborted `fetch` now genuinely interrupts an
   in-flight model call, not just stops the client from reading further SSE
   frames. An `AbortError` caught by the orchestrator's outer try/catch is
   distinguished from a real failure: the run is marked `CANCELLED` (not
   `FAILED`), a `RUN_CANCELLED` event is written, and the client receives a
   `{type: 'cancelled'}` frame instead of a scary error message.

**What this does not do**: it does not abort a capability's own internal
model call (e.g. `youtube.runYouTubeAnalyst`'s sub-agent) mid-flight —
capabilities run to completion once started, by design (see mechanism 1
above). Threading a signal through every specialist analyst is a larger,
lower-value change deferred to a future phase; the checkpoint mechanism
already bounds the worst case to "one more capability batch completes."

**Frontend**: `apps/web/src/components/app/agent/agent-chat.tsx` captures
the run id from a new, early `{type: 'run_created', agentRunId,
conversationId}` SSE event (yielded immediately after the `AgentRun` row is
created, well before the existing `done` event that previously was the only
place a client ever saw the id) and shows a "Stop" button in place of "Send"
while a turn is in progress, which both calls the cancel endpoint and
aborts the local `fetch`.

## 5. Configurable approval expiration

Previously `APPROVAL_TTL_MS` was a hardcoded 7-day constant. It is now
`GovernancePolicy.approvalTtlMinutes` (`packages/services/src/governance/
index.ts`), a Zod field with `.default(10_080)` so a policy stored before
this field existed still parses to the same 7-day value rather than being
silently rejected. Bounds: 15 minutes to 30 days.
`requestIntegrationAction` reads the org's policy at request time and uses
it; a policy that fails to parse falls back to the original hardcoded
constant, not to zero or an error. A field was added to the AI governance
settings UI (`/app/settings/ai-governance`) so an ADMIN+ can actually change
it, not just the backend value. This is a single org-wide value, not a
per-risk-class schedule (the brief's example lists "15 minutes / 1 hour / 24
hours" as different classes might want different windows) — a genuine,
disclosed scope reduction; see `docs/PHASE-4-REPORT.md` §16.

## 6. Tool Registry and real tool-calling (infrastructure only)

`packages/services/src/agent/tool-registry.ts` does not implement any new
tool — it catalogues the existing, closed `integration-tools.ts` allowlist
(4 tools: `integrations.list_connections`, `integrations.get_capabilities`,
`wordpress.list_content`, `integrations.propose_action`) with the metadata
shape the brief asks for: `category` (READ/ANALYSIS/GENERATION/ACTION),
`riskLevel` (derived from each tool's real `CapabilityLevel`), `providerType`
(`INTERNAL | INTEGRATION | MCP` — see §7), `organizationScoped`. Nothing
about authorization changes: each tool's `execute` still dispatches through
`runIntegrationTool`, which still calls `assertCapabilityUsable` /
`assertGovernanceAllows` exactly as before.

**Separately, `packages/ai` gained real, generic tool-calling support** — a
`ToolDefinition[]` type already existed in `packages/ai/src/types.ts` but
was never wired to anything (confirmed dead code by grep before Phase 4).
`GenerateTextOptions` now accepts `tools` and `maxSteps`;
`VercelAIProvider.generateText` maps them to the Vercel AI SDK's native
multi-step tool-calling loop and returns `toolCalls`/`steps` on the result.
This is a real, tested capability (`packages/ai/src/providers/
vercel.test.ts`) — a caller can hand a model a closed tool list today and
get back genuine, bounded, model-driven multi-step tool selection.

`buildAgentToolDefinitions(ctx)` bridges the two: it turns the tool
registry into `packages/ai`'s `ToolDefinition[]`, each `execute` closing
over the caller's server-derived `IntegrationToolContext` (never taking
organizationId from the model).

**Deliberately not wired into any live orchestrator capability this
phase.** `docs/AGENTS.md` is explicit that no capability in the live
`growth-agent` path makes a model-driven tool call today — every capability
is still our own code calling its own function, and the model only ever
sees the result. Wiring `buildAgentToolDefinitions` into an 8th capability
(or into `org-context`) would have been the single highest-risk change
available this phase — it changes the actual runtime behavior of a mature,
security-audited orchestrator, for a narrow, already-safe 4-tool surface
that mostly reports connection status. Given the brief's own repeated "do
not overbuild" instruction and the option to ship the tested primitive
without touching the live loop, this was deferred rather than rushed.
**This is the clearest, most concrete "next slice" for whichever phase picks
Phase 4's work back up** — the infrastructure, tests, and registry are
ready; what's left is one new capability registration plus re-running the
adversarial test suite against the now-live tool-calling path (see §1 of
`docs/PHASE-4-REPORT.md`'s recommended next phase).

## 7. MCP readiness

`ToolProviderType = 'INTERNAL' | 'INTEGRATION' | 'MCP'` exists on
`AgentToolMetadata` as a forward-compatible field — every tool registered
today is `'INTEGRATION'`. No MCP server is connected, and none should be
without its own authorization review (the brief is explicit: "do not
blindly connect arbitrary MCP servers"). Worth recording: the Vercel AI SDK
already installed in this repo (`ai@4.3.19`) ships
`experimental_createMCPClient` and an `MCPTransport` type — MCP client
support is already present as a library capability, just unused. A future
MCP integration's tools would need to pass through the exact same
authorization/risk/approval/audit/timeout/retry/org-isolation pipeline
every `INTEGRATION` tool already does — the registry's `ToolProviderType`
field exists specifically so that pipeline doesn't need to branch on where
a tool came from.

## 8. Durable execution / Temporal readiness

No Temporal (or equivalent durable-workflow engine) exists in this
repository, confirmed by the Phase 4 audit. Per the brief's own instruction
("do not add Temporal merely for architectural fashion... document where it
could be introduced"), none was added. The existing boundary already
matches the brief's own suggested shape:

```
Agent Runtime (orchestrator.ts)
  → Execution Orchestrator (the turn's own stage sequencing — gather/plan/
    run/synthesize/write, now event-logged)
  → Worker (apps/worker, BullMQ — the agent-run queue and its
    processAgentJob exist and are correctly registered, see below)
  → Tool Activities (capabilities.ts / integration-tools.ts / the
    approval executors — each already a discrete, independently retriable
    unit of work)
```

If a future phase adopts Temporal, the natural mapping is: the turn becomes
a Workflow, each capability call and each approval-gated executor becomes
an Activity, and `AgentRunEvent` becomes largely redundant with Temporal's
own event history (though the DB rows would likely stay, for querying
without a Temporal client). **`TIMED_OUT`** (the reserved `AgentRunStatus`
value, §3) is exactly the kind of thing a durable workflow engine's own
timeout primitive would set — today nothing sets it, because the
orchestrator has no wall-clock deadline of its own (see §9).

**A pre-existing, real gap this audit surfaced**: `apps/worker`'s
`agent-run` BullMQ queue and its `processAgentJob` processor
(`apps/worker/src/processors/agent.ts`) are correctly implemented and
registered in `main.ts` — but **nothing in the codebase ever calls
`agentRunQueue.add(...)`**, confirmed by a repo-wide grep. It is dead
infrastructure: built, wired, never driven. Interactive chat runs entirely
inline in the web process via SSE (which is non-blocking — a `ReadableStream`
doesn't hold the Node event loop — but is still a synchronous request/response
from the user's point of view). Phase 4 did not activate this queue: doing
so needs a real trigger and a real "background run" UX (the brief's own
example — "analyze my entire website" as a background job the user can walk
away from and come back to) that didn't exist before and would be new
product surface, not a bug fix. `getAgentRun`/`listAgentRunEvents` (§3) are
exactly the read APIs a background-run UI would need to poll, built ahead
of that future need.

## 9. Loop limits, retries, timeouts — current state, honestly

The brief asks for `MAX_ITERATIONS`, `MAX_TOOL_CALLS`, `MAX_RUNTIME`,
`MAX_TOKENS`, `MAX_COST` and a graceful stop message. What exists today:

- **Tool-call cap**: hard, structural — a turn runs at most 5 capabilities
  (`capIds.slice(0, 5)` in the orchestrator, unchanged from before Phase 4).
  `toolCallCount` (§3) now records the real count for observability.
- **Iteration cap**: the turn loop itself has exactly one "iteration" per
  capability batch (`iterationCount` is incremented once per turn today,
  since capabilities run concurrently rather than in a loop) — there is no
  unbounded loop to bound, because the architecture is a fixed pipeline, not
  an open-ended agentic loop. This differs from the brief's implicit
  assumption of a repeating tool-call loop; it's a consequence of this
  codebase's capability-function-call design (§6) rather than a gap.
- **Token/cost cap**: `usage.enforceAiBudget` already gates the whole turn
  **before** it starts (org-level `AI_REQUESTS`/`AI_TOKENS` plan caps,
  pre-existing). There is no **mid-turn** token budget that can stop a turn
  partway through — if a turn is already running, it runs to completion or
  is cancelled (§4), it does not self-terminate for exceeding a per-turn
  token estimate, because none is tracked per-turn today (only per-org,
  cumulatively).
- **Wall-clock timeout**: `AI_REQUEST_TIMEOUT_MS` bounds each **individual**
  model call (pre-existing, `packages/ai`'s `withResilience`); there is no
  timeout on the **whole turn** — a turn with several slow-but-under-timeout
  capability calls in sequence could still take longer than any single
  `MAX_RUNTIME` a deployment might want. `TIMED_OUT` exists in the status
  enum for exactly this, unimplemented pending a decision on where the
  wall-clock check should live (the orchestrator itself, or a wrapping
  timeout in the route/worker).

None of this is a regression — every one of these gaps existed identically
before Phase 4 and is disclosed here rather than left implicit, per the
brief's own repeated instruction not to claim more than was verified.

## 10. Usage/cost metering fix

**A real, verified-by-audit gap, fixed**: `growthAgentDepsFromEnv` built its
`ProviderRegistry` with **no usage sink** — `createRegistryFromEnv()` with
no argument — so of the up-to-6 model calls a single turn can make
(planner, up to 5 capability sub-agents, synthesis, response writing), only
the **final synthesis call's** usage ever reached the org's `AI_REQUESTS`/
`AI_TOKENS` billing meters (via the separate, post-hoc
`recordAgentRunUsage(topLevelAgentRun)` call). Every other model call's real
cost was invisible to billing enforcement. Fixed:
`growthAgentDepsFromEnv({db, organizationId, actorId})` now builds a real
`createAiUsageSink` and passes it into `createRegistryFromEnv([sink])`, so
**every** model call this turn makes reports its own usage independently,
regardless of which capability or stage made it. Both call sites
(`/api/agent/stream/route.ts`, `agent/jobs.ts`'s worker path) were updated.

**What is not fixed, disclosed rather than hidden**: the top-level
`AgentRun.tokensPrompt/tokensCompletion/costUsd` display columns still
reflect only the synthesis call's usage (the orchestrator's existing
behavior, unchanged) — the **billing enforcement** is now correct (every
call is metered), but a user looking at one `AgentRun` row's displayed cost
will still see a number lower than the turn's true total spend, since
sub-agent calls write their own separate `AgentRun` rows with their own
correct totals rather than rolling up into the parent. A future phase could
aggregate this into the parent row's `output` JSON for a truer per-turn
cost display; this phase fixed the correctness-critical half (billing) and
disclosed the cosmetic half (display) rather than expanding scope further.

## 11. Dry-run mode

`AGENT_DRY_RUN=true` (or `1`) makes the three WordPress approval executors
(`createDraft`, `executeUpdatePost`, `executePublishPost` in
`packages/services/src/wordpress/actions.ts`) stop **after** their real
connection/capability checks — the same checks a live call would fail on
still run — and return a simulated, `dryRun: true`-labelled result instead
of making any WordPress API call. Verified live (not just asserted) via a
test using the existing fake-WordPress-transport harness: the call count to
the fake WordPress server is identical before and after the dry-run call —
zero new calls. A denied capability (e.g. missing `edit_posts`) still
throws in dry-run mode, confirmed by a dedicated test — dry-run never
short-circuits past a real authorization failure. Not a per-request flag —
a deployment-wide switch, matching the brief's own framing ("a safe
development mode"), never something a client request can toggle.

## 12. Structured errors

The brief's Part 32 error-code vocabulary
(`AI_PROVIDER_ERROR`/`TOOL_TIMEOUT`/etc.) now has one live member:
`AgentRun.errorCode` is set to `'AI_PROVIDER_ERROR'` when a turn fails for
any reason other than cancellation (the orchestrator's existing catch-all
error path, which already never leaks the raw exception message to the
client — that behavior predates Phase 4). The remaining codes in the
brief's list are not yet systematically mapped from every failure site
(integration timeouts, rate limits, connection expiry, etc. still surface
through the pre-existing `AppError` code system —
`integration_error`/`provider_unavailable`/`usage_limit_exceeded`/etc. —
which serves the same purpose under different names). Unifying the two
vocabularies is a documentation/refactor task for a future phase, not a
security or correctness gap: every failure path already returns a
user-safe message and never a raw stack trace, which is the substance of
Part 32's requirement.

## 13. Testing

New test files: `packages/ai/src/providers/vercel.test.ts` (tool-calling
mapping, 3 tests), `packages/services/src/agent/tool-registry.test.ts` (4),
`packages/services/src/agent/cancellation.test.ts` (4),
`packages/services/src/agent/events.test.ts` (3), plus new cases added to
`packages/services/src/wordpress/wordpress.test.ts` (dry-run, 2) and
`packages/services/src/approvals/approvals.test.ts` (configurable TTL, 1).
Existing fake-DB test harnesses in `orchestrator.test.ts` and
`agents/ai-red-team.test.ts` were extended with `agentRun.updateMany` /
`findUnique` and `agentRunEvent.create` stubs to reflect the orchestrator's
new calls — a mechanical update, not a behavior change to what those tests
assert. Full results, live-database verification method, and the honest
per-item accounting of what Phase 4 did and did not build are in
`docs/PHASE-4-REPORT.md`.
