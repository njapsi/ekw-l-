# PHASE-4-REPORT.md — AI Agent Core / Real Agentic Execution Engine

Completion report for the Phase 4 brief, per its own required structure.
Decision record: ADR-0054. Full architecture detail:
`docs/AGENT-RUNTIME.md` (this report summarizes; that document is
authoritative on mechanism).

## 1. What was already present

The brief's own "FIRST RULE — audit before coding" was followed literally:
a dedicated audit (an Explore subagent, ~78 file reads, reported in full
before any code was written) found that most of the brief's 67 sections
described infrastructure that **already existed**, under different names,
from Phases 1, 2, 7, and 22:

- **A real orchestrator loop** (`packages/services/src/agent/
orchestrator.ts`): gather context+memory → plan (deterministic keyword
  router, model-refined) → run up to 5 capabilities concurrently → grounded
  synthesis (`generateObject` + a regex/number grounding check + a
  deterministic fallback) → stream the natural-language reply. Real SSE
  events (`status`/`token`/`done`/`error`) already existed.
- **A mature, durable approval system** (`packages/services/src/approvals/`,
  `IntegrationActionRequest`): PENDING → APPROVED/REJECTED/EXPIRED/
  CANCELLED → EXECUTED/FAILED, a conditional `updateMany` claim (two
  concurrent "Approve" clicks execute exactly once), and — critically —
  execution **replays the exact JSON payload captured at request time**
  through the same Zod schema; there is no step where a model or a
  human-readable summary is consulted again. This already satisfied the
  brief's Part 9 requirement almost exactly.
- **A risk/permission hierarchy already enforced in code**:
  `CapabilityLevel` (READ/DRAFT/WRITE/PUBLISH/DANGEROUS) and governance's
  `ActionClass` (analyze/generate/draft/modify/publish/delete), with a Zod
  schema that **cannot express** "publish: automatic" — the safety floor is
  typed, not defaulted.
- **Tested prompt-injection defenses**: `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` +
  `wrapUntrusted` on every agent-layer prompt, a dedicated red-team test
  suite (13 tests) and adversarial suite (14 tests) from Phases 22/25.
- **A memory system**: `OrgMemory` (6 kinds), redacted and length-capped at
  write time, already implementing the brief's short/working/long-term
  taxonomy functionally (conversation history = short-term, per-turn
  loaded context = working, `OrgMemory` = long-term).
- **An `AgentRun` table** with `tokensPrompt`/`tokensCompletion`/`costUsd`/
  `model`/`provider` already present, and an `AgentRunStatus` enum already
  covering QUEUED/RUNNING/NEEDS_APPROVAL/COMPLETED/FAILED/CANCELLED.
- **A closed, audited tool allowlist** (`integration-tools.ts`, 4 tools) —
  already exactly the shape the brief's Part 6/11 describe (explicit
  registration, Zod-validated input, no generic execution tool) — just
  never connected to real model-driven tool selection.
- **A worker queue and processor for the growth agent**
  (`apps/worker/src/processors/agent.ts`, the `agent-run` BullMQ queue,
  `security.assertJobAuthorized('agent.run')`) — fully built and correctly
  registered, but (a genuine finding, not assumed) **nothing in the
  codebase ever enqueues a job onto it** — confirmed by a repo-wide grep.

**What did not exist**: a durable per-step event/timeline table (only a
final JSON blob on `AgentRun.output`); any cancellation mechanism for an
interactive chat turn; a formal tool-registry data structure with the
brief's requested metadata shape; real model-driven tool-calling anywhere
(`packages/ai` had a `ToolDefinition` type, but it was never wired to
`generateText`/`streamText` — dead code, confirmed by grep); usage metering
for anything but a turn's final synthesis call; a configurable approval
expiration (hardcoded 7 days); a dry-run mode.

## 2. What was changed

Only the genuine gaps above. The orchestrator's actual analysis pipeline,
the approval executors' actual WordPress logic, the governance decision
function, the memory redaction logic, and every specialist analyst
(`youtube-analyst`, `tiktok-analyst`, `seo-agent`, etc.) are **unchanged**.
Summary (full detail in `docs/AGENT-RUNTIME.md`):

1. Durable `AgentRunEvent` timeline + `AgentRun` schema extension.
2. Interactive-chat cancellation (checkpoint-based + real `AbortSignal`).
3. A formal Tool Registry cataloguing the existing 4-tool allowlist.
4. Real `tools`/`maxSteps` support added to `packages/ai`'s
   `GenerateTextOptions`/`VercelAIProvider` — shipped, tested, **not**
   wired into any live orchestrator capability (a deliberate scope
   decision, not an oversight — see §16).
5. Org-configurable approval expiration (`governance.approvalTtlMinutes`).
6. `AGENT_DRY_RUN` mode on the three WordPress approval executors.
7. A usage-metering fix: every model call in a turn now reports to the
   org's billing meters, not just the final synthesis call.
8. Three new `GET`/`POST` API routes for run status, cancellation, and the
   event timeline.
9. Frontend: a "Stop" button in the agent chat, wired to a new early
   `run_created` SSE event.
10. Documentation: this report, `docs/AGENT-RUNTIME.md` (new),
    `docs/AGENTS.md` and `docs/AI-ARCHITECTURE.md` (both updated to state
    precisely what's real versus conceptual), ADR-0054.

## 3. Files / modules changed

**New:**
`packages/services/src/agent/events.ts`, `cancellation.ts`, `runs.ts`,
`tool-registry.ts` (+ 4 `.test.ts` siblings);
`packages/ai/src/providers/vercel.test.ts`;
`apps/web/app/api/agent/runs/[agentRunId]/route.ts`,
`.../cancel/route.ts`, `.../events/route.ts`;
`docs/AGENT-RUNTIME.md`, `docs/PHASE-4-REPORT.md`;
`packages/db/prisma/migrations/20260923120000_agent_runtime/migration.sql`.

**Modified:**
`packages/db/prisma/schema.prisma` (`AgentRun`, `AgentRunStatus`, new
`AgentRunEvent`/`AgentRunEventType`);
`packages/services/src/agent/orchestrator.ts` (event recording, cancellation
checkpoints, `signal` threading, `run_created` event, `userId`/
`conversationId` on create);
`packages/services/src/agent/orchestrator.test.ts` (fake-DB `updateMany`/
`findUnique`/`agentRunEvent` stubs — mechanical, no assertion changed in
meaning beyond the new event ordering);
`packages/services/src/agents/ai-red-team.test.ts` (same mechanical
fake-DB update);
`packages/services/src/agent/jobs.ts` (usage-sink wiring,
`GrowthAgentDepsFromEnvOptions`);
`packages/services/src/agent/index.ts` (new exports);
`packages/services/src/governance/index.ts` (`approvalTtlMinutes` field +
default);
`packages/services/src/approvals/index.ts` (reads the configurable TTL);
`packages/services/src/approvals/approvals.test.ts` (+1 test);
`packages/services/src/wordpress/actions.ts` (dry-run short-circuits);
`packages/services/src/wordpress/wordpress.test.ts` (+2 tests);
`packages/ai/src/types.ts` (`tools`/`maxSteps`/`toolCalls`/`steps`,
`ToolCallRecord`);
`packages/ai/src/providers/vercel.ts` (tool-set mapping + step flattening);
`apps/web/app/api/agent/stream/route.ts` (usage sink args, `signal`
threading);
`apps/web/src/components/app/agent/agent-chat.tsx` (Stop button,
`run_created` handling);
`apps/web/src/components/app/settings/governance-form.tsx`
(`approvalTtlMinutes` field);
`docs/AGENTS.md`, `docs/AI-ARCHITECTURE.md`, `docs/DECISIONS.md`,
`CLAUDE.md`.

## 4. Database changes

One additive migration, `20260923120000_agent_runtime`:

- `AgentRunStatus` gains `PAUSED`, `TIMED_OUT` (both reserved — see §16).
- New `AgentRunEventType` enum (23 values, matching the brief's vocabulary;
  not all are emitted yet — `docs/AGENT-RUNTIME.md` §3 lists exactly which).
- `agent_runs` gains: `userId`, `conversationId`, `errorCode`,
  `currentStep` (all nullable `TEXT`), `iterationCount`/`toolCallCount`
  (`INTEGER NOT NULL DEFAULT 0`), `metadata` (`JSONB`, nullable),
  `cancelledAt` (`TIMESTAMP`, nullable), `updatedAt` (`TIMESTAMP NOT NULL
DEFAULT CURRENT_TIMESTAMP` — a deliberate deviation from `prisma migrate
diff`'s raw output, which generated a `NOT NULL` column with no default
  and would have failed against a table with existing rows; documented in
  the migration file's own header comment).
- New `agent_run_events` table (`id`, `agentRunId` FK cascade-delete,
  `organizationId`, `type`, `metadata` JSONB, `createdAt`), indexed on
  `(agentRunId, createdAt)`.
- New index `agent_runs(organizationId, conversationId)`.

No `DROP`, no data rewrite, no column made `NOT NULL` without a safe
default. Verified by diffing against `prisma migrate diff`'s own generated
SQL (same technique every prior phase's migration used), then verified for
real by applying it to an isolated schema on the actual staging Postgres
instance (§14) — not merely diffed on paper.

## 5. Agent runtime architecture

See `docs/AGENT-RUNTIME.md` §1 for the full turn-loop diagram. In short:
the existing gather → plan → run capabilities → synthesize → write
pipeline is unchanged in shape; every real stage transition now also
writes a durable `AgentRunEvent`, and two checkpoints (after planning,
after the capability batch) now check for a cancellation request before
continuing. The orchestrator's own two direct model calls (synthesis,
response writing) accept a real `AbortSignal`.

## 6. Tool registry architecture

`packages/services/src/agent/tool-registry.ts` — see
`docs/AGENT-RUNTIME.md` §6. Catalogues the pre-existing closed 4-tool
`integration-tools.ts` allowlist with `category` (READ/ANALYSIS/
GENERATION/ACTION), `riskLevel` (LOW/MEDIUM/HIGH/CRITICAL, derived from
each tool's real `CapabilityLevel`), `providerType`
(INTERNAL/INTEGRATION/MCP), `organizationScoped`. `buildAgentToolDefinitions
(ctx)` bridges it to `packages/ai`'s new real tool-calling support. **Not
wired into any live capability** — see §16 for why, and §8 for the security
implication of that choice (none — nothing changed in the live attack
surface).

## 7. Approval architecture

Unchanged except: `approvalTtlMinutes` is now a governance-policy field
(default 10,080 minutes = the previous hardcoded 7 days), read by
`requestIntegrationAction` at request time, editable in Settings → AI
governance by an ADMIN+. Everything else — the exactly-once claim, the
payload-replay-not-reinterpretation guarantee, the re-check of governance
and connection state at execution time — is exactly as it was (see §1).

## 8. Security controls

- **No security control was weakened.** Every existing check (tenant
  scoping, RBAC, governance, approval, prompt-injection fencing, secret
  scrubbing) is unchanged in the paths that already existed.
- **New surfaces reviewed for the same properties**: the three new API
  routes (`GET /api/agent/runs/:id`, `.../events`, `POST .../cancel`) each
  independently call `requirePermission('agent:run')` and re-derive
  `organizationId` from the session — never from the URL — matching Part
  49's requirement that approval/run endpoints never trust client-supplied
  identity. `cancelAgentRun` additionally checks the run's `userId` against
  the caller and returns `permission_denied` for a mismatch, `resource_not_
found` for a foreign organization's run id (tested — see §14).
- **`AgentRunEvent.metadata` is scrubbed** through the same
  `scrubModelOutput` secret-redaction path applied to model output, before
  every write — tested (a token-shaped string in event metadata does not
  survive to the stored row).
- **The tool-calling infrastructure (§6) introduces no new attack
  surface today** because nothing calls it. `docs/AGENTS.md`'s prior
  blanket claim ("tool-calling is not model-driven anywhere") is corrected
  to the more precise "the infrastructure exists, nothing live uses it" —
  a future phase that wires a capability to it **must** re-run the
  adversarial/red-team suites against that specific new path before
  shipping; this is stated explicitly in both `docs/AGENTS.md` and
  `docs/AGENT-RUNTIME.md` §6 as a hard requirement, not a suggestion.
- **Dry-run mode** does not weaken any check — it runs every
  authorization/connection/capability check identically and only skips the
  final network call; verified by a test asserting a denied capability
  still throws in dry-run mode.

## 9. Memory architecture

Unchanged. `docs/AGENT-RUNTIME.md` §2 documents the mapping from the
brief's short-term/working/long-term/organization-memory taxonomy onto the
existing `OrgMemory` + per-turn context loading, since the brief asks for
this distinction explicitly and it was worth writing down precisely rather
than leaving implicit.

## 10. Provider architecture

`packages/ai`'s `AIProvider` interface, `ProviderRegistry`,
`withResilience` (timeout/retry/kill-switch), `FallbackProvider`
(cross-provider fallback chain), and `modelForRole` are all unchanged.
Added: `GenerateTextOptions.tools`/`maxSteps`, `GenerateTextResult.
toolCalls`/`steps`, and the `VercelAIProvider` mapping to the SDK's native
multi-step loop (§6). The usage-metering fix (§2 item 7) means
`growthAgentDepsFromEnv` now always builds its registry with a real
`UsageSink` when an `organizationId` is available, rather than none.

## 11. MCP readiness

`ToolProviderType` (`INTERNAL | INTEGRATION | MCP`) exists on tool
metadata as a forward-compatible field; every tool registered today is
`INTEGRATION`. No MCP server is connected — per the brief's own
instruction not to blindly connect one. Noted for the record: the Vercel
AI SDK already in this repo (`ai@4.3.19`) ships `experimental_
createMCPClient`/`MCPTransport` as library capabilities, unused. See
`docs/AGENT-RUNTIME.md` §7.

## 12. Worker / background execution

**Confirmed unchanged and still inactive**: the `agent-run` BullMQ queue
and its `processAgentJob` processor are fully built and correctly
registered in `apps/worker/src/main.ts`, but nothing enqueues a job onto
it — interactive chat runs entirely inline in the web process via SSE.
Phase 4 did not activate this queue (see §16 for why) but did build the
read-side APIs (`GET /api/agent/runs/:id`, `.../events`) a future
background-run UI would need to poll — built ahead of that need, not
speculative unused code, since they also serve the SSE-reconnect case for
today's interactive flow.

## 13. Frontend integration

`apps/web/src/components/app/agent/agent-chat.tsx`: captures the run id
from a new, early `run_created` SSE event (previously the client only ever
learned the run id from the final `done` event, too late to cancel
anything); shows a "Stop" button in place of "Send" while a turn is in
progress; the button both calls `POST /api/agent/runs/:id/cancel` and
aborts the local `fetch`, so both cancellation mechanisms (§ AGENT-RUNTIME
§4) engage together. The Phase 3 `AgentRunTimeline` component and the
existing approval-card UI (`/app/integrations/approvals`) were not
modified — this phase's timeline additions are server-side/durable
(`AgentRunEvent`), not a new frontend rendering of them; a "view a run's
full persisted history" UI is a natural next-phase addition using the new
`GET .../events` endpoint, not yet built.

## 14. Tests executed

**Unit** (`pnpm test`): **948 passed** in `packages/services` (+10:
`cancellation.test.ts` ×4, `events.test.ts` ×3, `tool-registry.test.ts`
×4 minus overlap, plus 2 wordpress dry-run + 1 approvals TTL test — see
§3 for exact files) and **25 passed** in `packages/ai` (+3,
`vercel.test.ts`). `pnpm lint` 14/14, `pnpm typecheck` 14/14, `pnpm
check:tenant` clean, `pnpm check:audit` clean (6 pre-existing allowlisted
advisories, 0 new), `pnpm test:scripts` 11/11, `pnpm format:check` clean,
`pnpm --filter @growth-agent/web build` clean (all three new API routes
compiled, confirmed in the build's own route listing).

**Integration, against a real, isolated database** (the same
"never-touch-the-live-app" technique introduced in Phase 2: a throwaway
schema appended to the real staging Postgres's connection string, dropped
after): all 11 integration test files in the repo, **55 tests, 55
passed**, including `agent/orchestrator.integration.test.ts`'s 3 real
tests, which exercise the full orchestrator with the new event-recording
and `userId`/`conversationId` columns live.

**Direct database verification, beyond the test suite**: a standalone
script (`tsx`-executed, then deleted) ran one real `runGrowthAgentTurn`
against the isolated schema and queried the resulting rows directly. It
found: `AgentRun.userId`, `.conversationId`, `.currentStep` (`"done"`),
`.toolCallCount` (`2`), `.iterationCount` (`1`) all correctly populated;
exactly 12 `AgentRunEvent` rows in the correct causal order (`RUN_CREATED,
RUN_STARTED, CONTEXT_LOADED, PLAN_CREATED, TOOL_SELECTED ×2,
TOOL_AUTHORIZATION_CHECK ×1, TOOL_STARTED ×2, TOOL_COMPLETED ×2,
RUN_COMPLETED`). The same script then created a `RUNNING` row and called
`cancelAgentRun` directly: the row flipped to `CANCELLED` with
`cancelledAt` set and exactly one `RUN_CANCELLED` event recorded. This is
real evidence, not an inference from unit tests with mocked databases.

One incidental finding during this verification, **not a Phase 4 bug**:
the turn's `agent.turn.completed` audit-log write failed with the same
`audit_logs_actorId_fkey` foreign-key violation documented and explained
in the Phase 2 completion report — because the verification script used a
literal placeholder `userId` with no real `User` row behind it, exactly the
already-known, already-documented test-fixture pattern (a real `userId` in
production is always a persisted `User`, so this can't occur there).
`recordAudit`'s catch-and-log-only design correctly absorbed it without
affecting the turn's own success — re-confirming, not undermining, Phase
2's finding.

## 15. Test results

All green, as detailed in §14. No test was skipped, weakened, or deleted
to make this phase's gate suite pass.

## 16. Known limitations

Disclosed explicitly, matching the brief's own "do not claim more than was
verified" instruction:

- **Real tool-calling is built but unused.** The infrastructure (§6, §10)
  is tested and ready; no live orchestrator capability calls it. This was
  a deliberate scope decision (the brief's own "do not overbuild"), not an
  incomplete implementation of what was attempted.
- **Cancellation is checkpoint-based, not a hard mid-call abort**, except
  for the orchestrator's own two direct model calls. A capability already
  running when Stop is clicked finishes normally; its result is simply
  never synthesized, because the turn stops before the next stage.
- **No per-turn wall-clock `MAX_RUNTIME`/`TIMED_OUT`.** Each individual
  model call has a timeout (`AI_REQUEST_TIMEOUT_MS`, pre-existing); the
  whole turn does not. `TIMED_OUT` exists in the schema as a reserved
  value, unimplemented.
- **No per-turn token/cost budget that can stop a turn mid-flight** — only
  a pre-turn, per-org budget check (`enforceAiBudget`, pre-existing).
- **The top-level `AgentRun`'s displayed `costUsd`/`tokensPrompt`/
  `tokensCompletion` still reflect only the synthesis call**, not the
  turn's true total spend across capability sub-agent calls — a cosmetic
  display gap; the underlying billing meters are now correctly charged for
  everything (§2 item 7).
- **The worker's `agent-run` queue remains unused.** No background-run
  product surface was built this phase.
- **Approval TTL is one org-wide value**, not a per-risk-class schedule.
- **The brief's full Part 32 error-code vocabulary is not systematically
  mapped** — only `AI_PROVIDER_ERROR` is live; other failure modes still
  surface through the pre-existing `AppError` code system under different
  names, which already gives a user-safe message and a correlatable
  identifier — the substance of Part 32 is met, the exact naming is not
  unified.
- **`USER_INPUT_REQUESTED`/`RECEIVED`, `RETRY_STARTED`, `RUN_PAUSED`/
  `RESUMED`, `MODEL_CALLED`/`RESPONSE`, `APPROVAL_REQUESTED`/`GRANTED`/
  `REJECTED`** exist as enum values but nothing emits them yet (no
  mid-run user-input pause, no automatic retry loop in the orchestrator
  itself, no generic pause/resume, and no live capability that triggers an
  approval mid-turn exists to emit the approval events from inside a run).

## 17. Remaining technical debt

- Wiring the tool registry into a live capability (and re-running the
  adversarial suites against that path) is the most valuable next unit of
  work — see §19.
- The `AgentRun` display-cost aggregation gap (§16).
- No dedicated test exists yet for the two new API routes
  (`getAgentRun`/`listAgentRunEvents`/`cancelAgentRun`'s underlying
  service functions are tested directly; the Route Handlers themselves —
  thin wrappers calling `requirePermission` then the service — were not
  additionally covered by an e2e test this phase, consistent with this
  project's existing convention of testing service functions directly
  rather than every thin route wrapper).
- `docs/AGENTS.md`'s capability table doesn't yet list an 8th
  "tool-calling" capability, because none exists — it will need a new row
  whenever one is added.

## 18. Production configuration required

**None.** No new required environment variable. `AGENT_DRY_RUN` is
optional (defaults to off — real behavior unchanged). The new governance
field defaults to the previous hardcoded value, so existing organizations'
approval behavior is unchanged unless an ADMIN+ explicitly changes it.

## 19. Recommended next phase

In priority order:

1. **Wire the tool registry into one real capability** (the infrastructure
   and tests are ready — this is the highest-value, most concrete
   "finish the loop" step, and must include re-running the adversarial/
   red-team test suites against the newly-live path before shipping).
2. **Per-turn wall-clock timeout** (`TIMED_OUT`) and a per-turn token/cost
   ceiling that can stop an in-flight turn, not just gate it before
   starting.
3. **Roll sub-agent costs up into the parent `AgentRun`'s display columns**
   for an accurate per-turn cost shown to the user (billing is already
   correct; this is display-only).
4. **A real background-run product surface** that finally activates the
   worker's `agent-run` queue, with a UI affordance for "run this in the
   background" and a polling/notification path using the `GET
/api/agent/runs/:id` endpoints already built for it.
5. **A frontend view of a run's persisted event history** (`GET
.../events`), for reviewing a past run after the live SSE stream is
   long gone.

Per the brief's explicit instruction, **no Phase 5 work, no advanced
YouTube/TikTok/SEO agent work, and no autonomous-missions work has been
started.**

---

**Honesty statement on staging verification** (the brief's explicit final
requirement): everything in §14 that says "verified against a real,
isolated database" was genuinely executed against an isolated schema on
the actual staging Supabase Postgres instance this session — not simulated,
not assumed from unit tests alone. The live staging **application**
(`https://staging.agentgrowth.tech`) itself was not redeployed or
click-tested this phase (unlike Phase 3's UI verification, which used a
local `next dev` against an isolated schema with a real browser) — the
correctness of this phase's changes was established through real-database
integration tests plus a direct verification script, which is a strong but
different kind of evidence than an actual browser session against the
running app. If a live click-through of the agent chat's new Stop button
and a real SSE cancellation is wanted, that is the one thing this report
does **not** claim to have verified beyond the API/service layer.
