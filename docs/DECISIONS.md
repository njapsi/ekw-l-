# DECISIONS.md

Architecture Decision Record. Newest first. Each entry: **context → decision →
alternatives considered → consequences**. An ADR is amended, not deleted; a
reversal gets a new ADR that supersedes the old one.

---

## ADR-0056 — YouTube Growth Agent: benchmarking, patterns, a documented priority score, calendar/experiments/anomaly detection — routed through the existing Tool Registry and Policy Engine, not a new one

**Context.** Phase 6 asked for a production-grade "YouTube Growth Agent"
covering channel/video analysis, benchmarking against the creator's own
history, content-pattern detection, a priority-scored opportunity engine, a
content calendar, an experiment system, statistical anomaly monitoring, and
reporting — with an explicit, repeated instruction not to rebuild the
application, not to create a second agent runtime, and not to bypass the
Phase 4 Agent Runtime or the Phase 5 Tool Registry/Capability Registry/
Policy Engine/Orchestrator. The audit-first step found most of the
conceptual ground already covered under different names: real OAuth +
sync + a YouTube Analyst Agent + a monetization assessment (the original
integration), a Content Repurposing engine that already generates titles/
descriptions/scripts/hooks from a synced video, and — critically — a Growth
Agent orchestrator whose capability-execution path was a **direct function
call**, never routed through Phase 5's `executeAgentTool`/Policy Engine —
the one concrete architectural gap the brief demanded be closed for this
domain.

**Decision.**

1. **Six new pure-logic modules, each with fixed, documented thresholds an
   LLM never invents** (`packages/services/src/youtube/{benchmark,patterns,
opportunities,experiments,calendar,monitoring}.ts`): per-video
   benchmarking against the channel's own format-bucket median (≤180s =
   Short, ≥1.5×/≤0.5× peer median, minimum 5 peers); topic/format pattern
   detection reusing `metrics.ts`'s existing `topicClusters`; a five-factor
   -minus-one **PRIORITY SCORE** (`0.35·evidenceStrength +
0.25·historicalPerformance + 0.25·contentGap + 0.15·executionFeasibility`,
   deliberately omitting an `audienceRelevance` factor this deployment has
   no data for, rather than fabricating one); calendar generation that
   cycles through ranked opportunities and falls back to an honest
   "not yet assigned" placeholder rather than inventing a topic; experiment
   evaluation with a 15%-relative-change inconclusive threshold; and
   anomaly detection via a trailing-14-day mean/stdDev baseline at 2.5σ/4σ
   thresholds. None of these call the YouTube API directly — all operate on
   already-synced rows.
2. **`YouTubeOpportunity`/`YouTubeExperiment`/`YouTubeCalendarEntry` mirror
   existing model shapes rather than inventing new patterns** —
   `YouTubeOpportunity` is structurally `MonetizationOpportunity` for a
   different domain, reusing the existing `OpportunityStatus` enum and
   `promoteOpportunityToTask`'s exact pattern; calendar entries reuse
   `ContentIdea` via a nullable FK rather than duplicating idea storage.
   One additive migration (`20260925120000_youtube_growth_agent`), diffed
   against Prisma's own generated SQL.
3. **New YouTube tools are a closed allowlist dispatched through the
   existing Tool Executor, not a parallel authorization path.**
   `agent/youtube-tools.ts` mirrors `research/tools.ts`'s exact shape
   (`YOUTUBE_TOOL_NAMES`, Zod-validated `execute`, a `runYouTubeTool`
   dispatcher) and every capability-gated tool calls
   `assertCapabilityUsable` — the identical function
   `integration-tools.ts`'s WordPress/Google tools already use, not a
   second capability-checking mechanism. `tool-executor.ts` gained one new
   `kindOf()` branch (`'youtube'`) and one explicit dispatch arm; the
   existing rate limiting, `TOOL_CALLS` metering, and `AgentRunEvent`
   timeline apply unchanged. Ten tools were built; explicitly **not**
   built: five YouTube-specific content-generation tools (the Content
   Repurposing engine's 13 deliverable types already cover this — building
   a second path would violate hard rule 9), and separate weekly/monthly
   report tools (the reporting engine's `YOUTUBE` type has no such
   distinction — cadence is an automation-schedule concern).
4. **One new orchestrator capability, `youtube-growth`, is the one
   capability in the Growth Agent that calls `executeAgentTool` instead of
   a `youtube/*` function directly** — closing the architectural gap the
   audit found, for new functionality only. The two pre-existing YouTube
   capabilities (`youtube-analyst`, `youtube-monetization`) are untouched,
   per the brief's own backward-compatibility instruction.
   `CapabilityContext` gained an optional `agentRunId` so a capability's
   tool calls attach to the same turn's durable timeline the capability
   itself is already recorded against.
5. **No write/publish capability was added, because none can exist.**
   `integrations/google.ts` only ever requests read-only YouTube scopes;
   the capability matrix (`capability-matrix.ts`) reports all seven
   write-shaped capabilities as permanently unavailable with one shared,
   explicit reason, regardless of connection state — satisfying the
   brief's own acceptance test that a publish request must be refused with
   the real reason, never attempted.
6. **No per-video Analytics-API dimension sync was attempted.** Traffic
   -source and audience-demographic breakdowns need new Analytics-API
   dimension combinations this environment has no live YouTube credentials
   to verify — and the brief itself warns against constructing unsupported
   metric/dimension combinations. `AUDIENCE_ANALYTICS_READ` /
   `TRAFFIC_ANALYTICS_READ` report unavailable for this reason;
   benchmarking instead uses the already-reliably-synced lifetime Data-API
   stats.

**Alternatives considered.**

- _Expose all ten YouTube tools as live model-driven function-calling_ (the
  `packages/ai` tool-calling primitive Phase 4 shipped but left unwired).
  Rejected for the same reason Phase 4/5 left it unwired for every other
  domain: this phase's job was to close the specific "direct call bypasses
  the Tool Registry" gap for one new capability, not to flip on autonomous
  multi-step tool-calling for the whole orchestrator — a materially larger,
  higher-risk change than the brief asked for.
- _Extend `sync.ts` for per-video Analytics dimensions anyway,
  best-effort._ Rejected: an unverifiable API call shipped without live
  testing is exactly the failure mode hard rule 1 and the brief's own
  warning exist to prevent. Documented as deferred instead (§8 of
  `docs/YOUTUBE-GROWTH-AGENT.md`).
- _A parallel `youtube-content-generation` tool set._ Rejected — the
  Content Repurposing engine already does this for a synced YouTube video;
  a second path would be undetectable duplication that could drift from
  the first.

**Consequences.** The YouTube domain now has one capability
(`youtube-growth`) that proves the Phase 4/5 architecture is load-bearing
for genuinely new functionality, not merely built and left idle — a
template for wiring the remaining domains (TikTok, SEO) through the same
path in a future phase, should that be authorized. The five reserved-but-
unproduced `YouTubeOpportunityType` values and the two unavailable
analytics capabilities are an honest, disclosed gap rather than a silent
one. No live YouTube OAuth credentials exist in this sandbox, so none of
this phase's read paths against synced data, nor the pre-existing sync
path they depend on, were re-verified against a real account — the same
disclosed limitation as every prior YouTube-touching phase.

---

## ADR-0055 — Tool ecosystem, MCP & agent orchestration: a Policy Engine, a real MCP client, and metered tool calls — native authorization paths untouched

**Context.** Phase 5 asked for a production-grade "tool ecosystem" platform:
capability discovery, a central Tool Policy Engine with a seven-outcome
precedence model, MCP (Model Context Protocol) server support end to end
(registry, trust levels, discovery, namespacing, execution, untrusted-output
handling), a controlled web-research tool, rate limiting/circuit-breaking/
caching for tool calls, and a large surrounding checklist (orchestration
primitives, tool versioning, a marketplace, admin UI). The brief's own
first rule was again "audit before coding." That audit found: no MCP code
anywhere in the repo (confirmed by exhaustive grep — only a placeholder
`ToolProviderType` value from Phase 4); a real but _unused_ MCP client
already inside the installed `ai@4.3.19` dependency
(`experimental_createMCPClient`); a mature retry/circuit-breaker/timeout
module (`integrations/resilience.ts`) designed for exactly this kind of
reuse; a governance system (`governance/index.ts`) whose decision function
already covers 5 of the 6 outcomes the brief's Policy Engine wants; a
`ConnectionState`/capability-resolution system (`integrations/contract.ts`)
that already _is_ per-user dynamic capability discovery, just under a
different name; and a usage-metering idempotency pattern
(`usage/record.ts`) directly reusable for tool-call metering, which had
never existed for any tool call before this phase.

**Decision.**

1. **A pure, exhaustively-tested Policy Engine** (`agent/policy-engine.ts`)
   implements the seven-outcome precedence
   (ALLOW/DENY/REQUIRE_APPROVAL/REAUTH_REQUIRED/RATE_LIMITED/
   QUOTA_EXCEEDED/UNAVAILABLE) as one synchronous function over pre-resolved
   facts — no I/O, mirroring `contract.ts`'s own "deliberately pure"
   convention. It does **not** replace or shadow the native tool
   allowlist's existing, already-audited authorization (governance +
   `assertCapabilityUsable`, inside `integration-tools.ts`'s own
   `execute()` functions) — that stays exactly as it was. The Policy Engine
   is instead the primary authorization surface for the two tool kinds
   that had none: MCP tools and research tools, and a reusable decision
   function `capability-discovery.ts` calls to answer "what can this org do
   right now" without duplicating governance logic.
2. **Capability Discovery is a read composition**, not a new capability
   model. `agent/capability-discovery.ts` combines the existing Connection
   Center (`integrations/center.ts`) and governance
   (`governance/index.ts`) — plus one new MCP-specific branch — into the
   grouped, outcome-labelled view the brief asks for. No new "capability"
   concept was invented; `IntegrationCapability`/`ResolvedCapability`
   already were one.
3. **MCP gets a real client, not a stub.** `packages/ai/src/mcp.ts` wraps
   the installed SDK's `experimental_createMCPClient` (protocol version
   `2024-11-05`, confirmed from the SDK's own compiled source — not the
   brief's referenced newer specification, disclosed rather than implied)
   behind a small typed surface, kept in `packages/ai` (not
   `packages/services`) to preserve the existing "no provider SDK outside
   its owning package" boundary. `packages/services/src/mcp/*` is the org
   -facing layer: `registry.ts` (tenant-scoped CRUD, AES-256-GCM-sealed
   credentials via the existing `crypto/tokens.ts`, mirroring
   `WordPressSite`'s pattern exactly), `discovery.ts` (authenticate →
   discover → validate schema → namespace `mcp.<slug>.<name>` → classify
   risk from trust level alone, never a name/description guess → store
   disabled), `execute.ts` (both gates re-checked on every call — server
   enabled AND tool enabled — output size-capped and secret-scrubbed
   before it can reach a model prompt). A newly connected server starts
   `UNVERIFIED_EXTERNAL` / disabled; every discovered tool starts disabled;
   nothing is exposed to the agent until an admin explicitly opts it in,
   twice (server, then tool).
4. **A hand-rolled, protocol-correct fixture MCP server**
   (`packages/ai/src/mcp-fixture.ts`) stands in for "a controlled test MCP
   server" (Part 114) — reverse-engineered from the installed SDK's own
   compiled JSON-RPC implementation (`initialize` →
   `notifications/initialized` → `tools/list`/`tools/call`), not a mock of
   our own wrapper. `discovery.test.ts` and `mcp.test.ts` exercise the real
   wire protocol end to end against it — this is real verification of the
   protocol-handling code, not a stub of the thing under test, though it is
   **not** a live external MCP server (see Consequences).
5. **A conservative new governance bucket, backward-compatible.**
   `GOVERNED_INTEGRATIONS` gains `'MCP'`, defaulting every org to
   analyze-only automatic and everything else disabled — an MCP tool must
   clear its own enable flag _and_ this org-wide floor. The schema change
   uses `.default()` on the new key specifically (not a blanket schema
   version bump) so a pre-Phase-5 stored policy still parses with its
   existing customizations intact, rather than silently reverting to
   `DEFAULT_POLICY` in full (the same class of bug the schema's own
   `approvalTtlMinutes` field already guards against, generalized).
6. **The research tool is `fetch` + `search`, not a generic browser.**
   `research/fetch.ts` reuses the crawler's existing `seo/fetch.ts`
   `fetchPage` directly — the same SSRF/DNS-rebinding defense, redirect
   handling, and decompression caps, zero new implementation (Part 42's
   explicit instruction). `research/search.ts` has no configured provider
   (no search API key infrastructure exists in this deployment) and
   returns a deterministic `{ available: false, reason }` rather than
   fabricate results — following `billing/gateway.ts`'s `NullBillingGateway`
   convention and hard rule 1 (never fabricate data).
7. **One controlled tool executor for every kind.** `agent/tool-executor.ts`
   wraps native, research, and MCP calls uniformly with a real per-org
   `TOOL_CALLS` usage meter (new `UsageMeter` value, idempotent via the
   existing `recordUsage` pattern), a per-tool rate limit
   (`security.checkRateLimit`), and the `AgentRunEvent` timeline — none of
   which existed for any tool call before this phase, native included. It
   does not re-implement native/research authorization; it dispatches to
   the existing `runIntegrationTool`/`runResearchTool` and maps whatever
   they throw into the same `ToolResultEnvelope`/`ToolErrorEnvelope` shape
   MCP calls return, so a caller never has to know which kind of tool it
   called to interpret the result.
8. **No dependency-graph orchestrator, no tool-result cache, no
   marketplace, no per-tool circuit-breaker persistence beyond the
   existing in-memory `CircuitBreaker` reused for MCP connections keyed
   per server id.** The brief's own Part 121 explicitly excludes the
   specialized growth agents and autonomous missions; this phase treated
   "sequential/parallel/conditional orchestration," "tool result caching,"
   and "a tool marketplace" the same way — genuinely new infrastructure
   with no current caller, deferred rather than built speculatively (see
   Alternatives).

**Alternatives considered.**

- _Wire the Policy Engine into the native tool allowlist's own
  authorization path, replacing `assertGovernanceAllows`/
  `assertCapabilityUsable`:_ rejected — that code is already audited
  (Phase 22/25's adversarial suites) and working; rerouting it through a
  new engine for architectural uniformity would risk regressing a mature
  security boundary for no behavioral gain, exactly the "parallel
  architecture" the brief's own preamble warns against.
- _A generic dependency-graph orchestrator with sequential/parallel/
  conditional/retry/compensation primitives:_ rejected for this phase —
  the existing growth-agent orchestrator's "run every planned capability
  concurrently" model has no caller today that needs a graph, and building
  one speculatively is exactly the overbuilding the brief repeatedly warns
  against; the primitive would have no real exercise the way the Policy
  Engine and MCP client get from capability discovery and the test suite.
- _A generic tool-result cache from day one:_ rejected — no tool call in
  this codebase is expensive enough yet to justify the invalidation
  complexity (cache-aside keyed by org+tool+args, staleness on
  write/reconnect/permission-change); the brief's own Part 69-70 caveats
  ("never let stale cache cause an incorrect action") argue for building
  this once a real caller demonstrates the need.
- _stdio MCP transport support:_ rejected for this phase — spawning an
  arbitrary local process from a web/worker request is a materially
  different security posture than an outbound HTTPS/SSE call, and the
  installed SDK doesn't ship it built-in; `McpTransportKind.STDIO` exists
  in the data model as a reserved value with an honest "not supported yet"
  error, not a silent no-op.
- _A real web-search provider (Bing/Google Programmable Search):_ rejected
  — no API key infrastructure exists, and adding one with no real provider
  behind it would repeat the exact "documented but not implemented"
  pattern `docs/FORENSIC-AUDIT.md` already flagged and had to walk back
  once this session (Search, Sentry, OTEL, S3).

**Consequences.**

- Migration `20260924120000_tool_platform` (additive: one new
  `UsageMeter` value, five new enums, two new tables — `McpServer`,
  `McpServerTool`), verified against `prisma migrate diff`'s own generated
  SQL byte-for-byte equivalent.
- `docs/AGENTS.md`'s "tool-calling infrastructure exists, nothing live
  uses it" claim (ADR-0054) is now one degree more nuanced: MCP tool
  calls _are_ live-executable end to end through `tool-executor.ts`, but
  only for tools an org's admin has explicitly enabled on an explicitly
  enabled server — there is still no model-driven tool-selection loop in
  the growth-agent's own orchestrator (that remains ADR-0054's deferred
  item).
- **Disclosed, not claimed as verified:** this phase's MCP client and
  fixture server were exercised against each other extensively (unit
  tests, real JSON-RPC wire protocol), and the full non-DB gate suite
  (lint/typecheck/1040+ services tests/30 ai tests/build/tenant-scope/
  audit-allowlist/format) is green — but the new
  `mcp/tenant-isolation.integration.test.ts` was **not run against a real
  Postgres this phase**: this session's own safety controls declined both
  extracting the staging database credential from the deployment host and
  writing cleanup commands to that host's shell, so the established
  isolated-staging-schema technique prior phases used could not complete.
  The test is structurally sound (typechecks, lints, self-skips correctly
  without a database) but is unverified against a live database — see
  `docs/PHASE-5-REPORT.md` for the full accounting.
- Full results, gate status, and the phase's honest scope accounting are
  in `docs/PHASE-5-REPORT.md`, `docs/TOOL-PLATFORM.md`, and `docs/MCP.md`.

---

## ADR-0054 — Agent runtime: durable event timeline, checkpoint cancellation, a formal tool registry, real (but unwired) tool-calling, and a usage-metering fix

**Context.** Phase 4 asked for a "core AI Agent Runtime" — multi-step tool
loops, tool authorization, a durable timeline, human-in-the-loop approval,
cancellation, retries, background execution, provider abstraction, and MCP
readiness. Its own first rule was "audit before coding." That audit
(`docs/PHASE-4-REPORT.md` §1) found most of this brief already implemented
under different names in prior phases: a real orchestrator loop
(`orchestrator.ts`), a mature approval system with exactly-once execution
and payload replay rather than model reinterpretation
(`IntegrationActionRequest`), governance-based risk gating that structurally
cannot express an unsafe policy, and prompt-injection defenses already
red-teamed. The genuine gaps were narrower: no durable per-step event log
(only a final JSON blob), no way to cancel an interactive chat turn, a
`ToolDefinition` type in `packages/ai` defined but never wired to anything,
the existing closed tool allowlist never connected to real model
tool-calling, sub-agent AI costs invisible to org billing, a hardcoded
approval TTL, and no dry-run mode.

**Decision.**

1. **Extend, don't rebuild, the orchestrator.** `AgentRun` gained additive
   columns (`userId`, `conversationId`, `currentStep`, `iterationCount`,
   `toolCallCount`, `errorCode`, `metadata`, `cancelledAt`, `updatedAt`) and
   two new status values (`PAUSED`, `TIMED_OUT`, both reserved for future
   use). A new `AgentRunEvent` table gives the brief's requested durable
   timeline, written at every real stage transition the orchestrator
   already has, metadata scrubbed exactly like model output.
2. **Cancellation is checkpoint-based, not a mid-call abort**, except for
   the orchestrator's own two direct model calls (synthesis, response
   writing), which do get a real `AbortSignal` via `packages/ai`'s
   pre-existing `signal` option. A capability already running when Stop is
   clicked finishes; the turn simply doesn't advance to the next stage.
   This satisfies "never terminate halfway through a critical database
   transaction" without threading an abort signal through every specialist
   analyst — a much larger, higher-risk change for a narrower benefit.
3. **The Tool Registry catalogues, it does not reimplement**, the existing
   closed `integration-tools.ts` allowlist, adding the risk/category/
   provider-type metadata shape the brief asks for. Authorization is
   unchanged — still inside each tool's own `execute`.
4. **Real tool-calling was built in `packages/ai` but deliberately not
   wired into any live orchestrator capability.** The dead `ToolDefinition`
   type now does something — `GenerateTextOptions.tools`/`maxSteps` map to
   the Vercel AI SDK's real multi-step tool-calling loop, tested. Wiring it
   into the live `growth-agent` path would be the single highest-risk
   change available this phase, changing actual runtime behavior of a
   mature, security-audited system, for a narrow 4-tool surface. Given the
   brief's repeated "do not overbuild," shipping the tested primitive
   without touching the live loop was judged the safer, still-genuine
   progress — and is now the clearest next slice for a future phase.
5. **Approval TTL becomes an org-configurable governance field**
   (`approvalTtlMinutes`, default 10,080 = the previous hardcoded 7 days,
   `.default()` so old stored policies still parse), not a per-risk-class
   schedule — a disclosed scope reduction from the brief's 15-min/1-hour/
   24-hour example.
6. **Dry-run mode (`AGENT_DRY_RUN`) sits after authorization checks, before
   the network call**, in the three WordPress executors — a denied
   capability still throws in dry-run; only the actual external write is
   skipped.
7. **The usage-metering gap is fixed at the sink, not by restructuring
   `AgentRun`'s display columns.** Every model call in a turn now reports
   to the org's billing meters via a real `UsageSink`; the top-level
   `AgentRun`'s displayed cost still reflects only its own synthesis call
   (a cosmetic, disclosed limitation) — billing correctness was prioritized
   over display completeness.
8. **No Temporal, no background-queue activation.** Per the brief's own
   instruction, Temporal is not added merely for architectural fashion; the
   existing Agent Runtime → Orchestrator → Worker → Tool Activities
   boundary already matches its own suggested shape, documented for a
   future adoption. The worker's `agent-run` BullMQ queue, found to be
   fully built but never enqueued to (dead infrastructure), was left
   inactive rather than wired to a synthetic trigger — activating it needs
   a real background-run product surface that doesn't exist yet.

**Alternatives considered.**

- _Rewrite the orchestrator around model-driven multi-step tool-calling
  end-to-end:_ rejected — the brief explicitly warns against overbuilding,
  and the existing deterministic capability-function-call design is already
  safer than a live tool-calling loop for the analysis use cases it serves.
- _A true mid-flight abort signal threaded through every capability:_
  rejected for this phase — checkpoint cancellation bounds the worst case
  (one more capability batch) at a fraction of the risk and code churn.
- _Per-risk-class approval TTLs:_ rejected as unnecessary complexity before
  any organization has asked for more than one number.
- _Activating the dead `agent-run` queue with a synthetic trigger just to
  prove it works:_ rejected — it would exercise infrastructure without
  serving a real user need, and risks masking the actual gap (no
  background-run UX exists) behind a hollow "it's wired now" claim.

**Consequences.**

- Migration `20260923120000_agent_runtime`, additive only; verified against
  a real, isolated staging-Postgres schema (never the live app), including
  a direct query confirming a real turn writes the exact expected 12-event
  causal sequence and that cancellation flips status atomically.
- `docs/AGENTS.md`'s "tool-calling is not model-driven anywhere" claim is
  now more precise: the infrastructure exists, nothing live uses it —
  future phases must revisit that doc and `docs/AI-SECURITY-AUDIT.md`'s
  tool-manipulation row together before wiring a capability to it.
- Full results, gate status, and the phase's honest scope accounting are in
  `docs/PHASE-4-REPORT.md` and `docs/AGENT-RUNTIME.md`.

---

## ADR-0053 — Design-system-first UI redesign; dark mode fixed at the token layer; Missions as a read model, not a new entity

**Context.** Phase 3 asked for an enterprise-grade UI/UX overhaul across
~40 screens, explicitly forbidding backend/database/auth rebuilds (Part 1).
An audit of the existing `packages/ui` found a real foundation (Button,
Card, Badge, Dialog, DropdownMenu, Tabs, EmptyState, PageHeader, all
consistently used) but real gaps: the Tailwind preset declared
`darkMode: ['class']` while `styles.css` only ever varied by media query —
no code ever set the `.dark` class, so existing `dark:` utilities were dead;
no Tooltip/Popover/Command/Toast/Progress primitives; no chart or motion
library; the dashboard was three placeholder stat cards; the AI Agent chat
had a single-line status string, no multi-step timeline.

**Decision.**

1. **Fix the design system once, let every page inherit it**, rather than
   hand-redesigning 40 pages that already share `Card`/`Badge`/`PageHeader`.
   Dark mode is fixed at the CSS-variable layer (`data-theme` and `.dark`
   set together by one `ThemeProvider`), so every existing and future
   consumer of those tokens gets correct dark mode for free.
2. **New primitives follow the existing file-per-component, thin-Radix
   -wrapper pattern** exactly (Tooltip, Popover, Progress, Switch, Toast,
   Command) — no new architectural pattern introduced for them.
3. **No chart or animation library.** Consistent with this codebase's
   established convention of hand-rolling before adding a dependency (the
   PDF writer, the cron parser, the Stripe REST adapter), Parts 20/41/39 are
   met with existing Tailwind utilities.
4. **Growth Missions (Part 36) is a presentational aggregation**, not a new
   `Mission` table. Part 1 forbids backend changes; a persisted Mission
   entity with fabricated status would also risk violating the master
   instruction's no-fake-data rule before it has anything real to show. It
   composes existing connection state and automation rules instead.
5. **One new backend surface, deliberately minimal**: `dashboard.
getDashboardSummary`, a pure read composition over four already-existing
   tenant-scoped reads plus one new scoped query, to give the dashboard real
   content instead of the `—` placeholders it showed before.
6. **The agent run timeline is ephemeral**, sourced live from the
   orchestrator's real SSE stage events, not persisted or replayed — the
   data model has no stage-by-stage record today, and inventing one is a
   backend change out of this phase's scope.
7. **Approval execution stays on its own page.** The chat now shows a
   richer description of what needs approval, but approve/reject remains on
   `/app/integrations/approvals`, where the permission check and exactly
   -once claim already live — duplicating that logic into the chat would
   be new attack surface for no verified benefit this phase.

**Alternatives considered.**

- _Hand-redesign every listed page:_ rejected as unrealistic for one phase
  and worse engineering than fixing the shared primitives once.
- _A new `Mission` schema now:_ rejected (point 4) — Part 1's own
  constraint, and nothing to persist yet that isn't derivable from existing
  tables.
- _Adding a chart/motion library:_ rejected as an unjustified dependency
  for what Tailwind utilities already cover at this phase's scope.
- _Embedding approve/reject in the chat:_ rejected (point 7) — no verified
  need, real risk of duplicating a security-sensitive code path.

**Consequences.**

- New deps: `@radix-ui/react-{tooltip,popover,progress,switch,toast}`,
  `cmdk`. No schema migration.
- A genuine production-build-breaking bug was found and fixed before
  release: `cmdk@1.1.1` exports its sub-components as flat named exports,
  not `Command.X` properties like older versions — every page would have
  failed to build had this shipped. See `docs/PHASE-3-REPORT.md` §9.
- A real mobile-UX bug was found and fixed via live testing: the mobile
  "More" drawer inherited the desktop sidebar's persisted collapse
  preference, rendering as an unlabeled icon-only dead end on a phone. Fixed
  by making the mobile drawer always render expanded regardless of the
  desktop preference.
- Full results, live-verification method, and an honest per-checklist-item
  accounting of what was and wasn't completed are in
  `docs/PHASE-3-REPORT.md`.

---

## ADR-0052 — Enterprise identity on the existing Auth.js: capability RBAC, server-side session registry, API keys, AI governance

**Context.** Phase 2 asked for multi-tenant enterprise identity:

- five roles with capability-based permissions;
- invitations, session management, security settings and an audit log;
- API keys, AI governance and worker authorization.

It also said not to replace working authentication or break existing users.
The audit of the existing system found it sound in design (Auth.js v5, JWT
sessions, DB-verified active org, a central `authorize()`) but found five
real defects:

1. **CRITICAL: account takeover through sign-up.** `signUpAction` set a
   password on any existing account without one (magic-link / Google users).
   Those emails are verified, so the attacker could sign in immediately.
2. **HIGH: role escalation.** `updateMemberRole` let an ADMIN grant OWNER
   (including to themselves) or demote an OWNER.
3. **MEDIUM: work continued after deletion was scheduled.** Automations kept
   running during an organization's deletion grace period.
4. **MEDIUM: invitations had loose ends.**
   - Accepting happened on a GET (link scanners could consume invitations).
   - An inviter who lost their rights could still grant roles through
     outstanding links.
   - There was no resend or revoke, and no email.
5. **HIGH (test integrity): every integration test was silently skipped.**
   All ten `*.integration.test.ts` files probed the database inside
   `beforeAll`, but chose `it` vs `it.skip` at collection time, before
   `beforeAll` ran. So they skipped even in CI with a real database. Earlier
   reports' "integration tests run in CI" was not true.

**Decision.**

1. **Keep Auth.js, JWT sessions and the cookie-plus-DB active-org model.**
   Add, don't replace.
2. **A capability permission catalog** (`rbac/permissions.ts`, 50
   permissions), a new **MANAGER** role, and strict cumulative roles. The
   old `Action` names stay as aliases through `LEGACY_ACTION_PERMISSION`. A
   test pins every existing role to exactly its old action set, so no
   existing user gained or lost access. Escalation rules live in one pure
   function (`checkRoleChange`).
3. **A server-side session registry despite JWTs.** Each JWT carries a
   `UserSession` id. `requireUser` rejects revoked or expired rows. "Sign out
   all other sessions" also bumps `sessionVersion`, which kills tokens issued
   before this change, and re-issues the current token via
   `unstable_update`. Device and IP reach the Auth.js callback through an
   `AsyncLocalStorage` scope set by the auth route. Only network prefixes are
   stored.
4. **Re-authentication by a fresh email sign-in**, not a password prompt.
   The session-update API is client-callable, so an `authAt` claim can only
   be set by a real sign-in. Sensitive changes need a sign-in within the
   last 15 minutes.
5. **API keys:** hash-only storage, scopes capped at the creator's
   permissions, and the creator re-checked on every request. `/api/v1`
   accepts only bearer keys and never cookies.
6. **AI governance as a validated per-org policy** whose schema _cannot_
   express automatic modify, publish or delete. It is enforced in approvals
   (request and execution), agent tools, the orchestrator and automations
   (save and run).
7. **Worker jobs re-derive authorization at execution time**
   (`assertJobAuthorized`).
8. **RLS stays deferred** (ADR-0035). The four application layers are made
   verifiable instead, with the integration suites fixed so they actually
   run.
9. **MFA: data model only.** The UI states it is not active, and passkeys
   are planned first.

**Alternatives considered.**

- _Database sessions instead of JWT:_ rejected. It would break edge
  middleware verification (ADR-0011) and sign every user out. The registry
  gives revocation without that.
- _A password prompt for re-auth:_ rejected (point 4).
- _Enabling RLS now:_ rejected without a real test database.
- _Rewriting every `requirePermission('legacy:action')` call site:_ rejected
  as needless churn. The aliases are exact and tested.

**Consequences.**

- Migration `20260922120000_enterprise_identity`, additive only.
- Every signed-in request does one extra indexed session lookup. Activity
  writes are throttled to once per 5 minutes.
- Existing sessions keep working until they naturally end or the user signs
  out others.
- The fixed integration suites run for the first time. Their results are in
  `docs/PHASE-2-REPORT.md`.
- Invitation emails need a configured transport. Otherwise the inviter gets
  a copyable link, as before.

---

## ADR-0051 — WordPress via Application Passwords, a unified sync ledger, refresh-ahead lifecycle, and an approval queue as the enforcement point

**Context.** ADR-0050 gave every integration one vocabulary. Phase 1 still
required a WordPress connector (zero code existed), shared API resilience, a
sync framework, token lifecycle management, AI tool exposure, and an
_enforced_ permission model. Until now the capability levels only described
behaviour.

**Decision.**

1. **WordPress uses core Application Passwords over the `wp/v2` REST API.**
   It does not use OAuth or a plugin. Application Passwords ship in WordPress
   core (5.6+), so no Growth Agent plugin has to be installed and maintained
   on customer sites. Credentials live in a new `WordPressSite` table, not in
   `oauth_connections`: there is no refresh token and no expiry, and the
   OAuth table's non-null token columns would be meaningless.
   WordPress-detected capabilities (`edit_posts`, `publish_posts`, …) act as
   the connection's "scopes", so `resolveCapabilities` works unchanged.
2. **User-supplied WordPress URLs reuse the crawler's SSRF guard.** Requests
   go through resolve → validate → pin. Redirects are never followed, because
   the credential travels in a header. Only GET is retried. This keeps hard
   rule 7 intact for the one new code path that fetches a user URL.
3. **A dedicated `integrations/resilience.ts`.** Existing provider clients are
   not retrofitted: their retry paths are tested and working. The breaker is
   in-process, not in Redis. A shared breaker would add a network hop to
   every provider call to protect against a condition the provider already
   signals with 429 / 5xx.
4. **`IntegrationSyncRun` is an additional ledger, not a replacement** for
   `youtube_sync_runs` / `tiktok_sync_runs`. Single-flight uses
   insert-then-check with a total order over `(startedAt, id)`, not a Redis
   lock. That needs no new infrastructure, and a crashed holder cannot leak a
   lock because stale runs close after 30 min.
5. **Refresh-ahead is rate-limited to once per 6 h per connection.** Google
   access tokens live 1 h. Refreshing everything within 15 min of expiry would
   refresh each connection ~4×/hour forever. Every 6 h is enough to discover
   a revoked refresh token before a user or a scheduled sync hits it.
6. **The approval queue is the only path to an external write.**
   `IntegrationActionRequest` + a closed executor registry, where every
   executor is WRITE / PUBLISH. Permissions are re-checked at execution time.
   A conditional `updateMany` claim means concurrent approvals execute once.
   There is no "skip approval" switch: hard rule 4 permits one ("automation
   mode"), but no such mode exists, so the safe default applies.
7. **Agent tools can observe and propose, never execute.** `propose_action`
   creates a PENDING request attributed to the agent (`source = AGENT`,
   audit `actorType = AGENT`). This extends ADR-0022 to integrations.
8. **Key rotation via `ENCRYPTION_KEY_PREVIOUS`.** `open()` accepts a row
   sealed with the previous key. The lifecycle sweep re-seals under the
   current key and logs how many credentials remain stale.

**Alternatives considered.**

- _WordPress OAuth via a companion plugin_ — rejected: every customer would
  have to install and trust our plugin, and core already provides a scoped,
  revocable credential.
- _A `WORDPRESS` value in `IntegrationProvider` + reuse of `oauth_connections`_
  — rejected (point 1).
- _Temporal / a workflow engine for sync_ — rejected: BullMQ repeatable ticks
  plus a DB ledger cover single-flight, retry and backoff at this scale
  (the Phase 0 recommendation stands).
- _Proactive refresh on every tick_ — rejected (point 5).

**Consequences.**

- Two new repeatable worker ticks (`integrations` queue).
- A new migration, `20260921120000_integration_platform`: four additive
  tables and no changes to existing ones. It was diffed against Prisma's own
  generated SQL and matches exactly.
- WordPress sites count toward `CONNECTED_ACCOUNTS`.
- Scheduled syncs spend provider quota daily (YouTube ≈ one full incremental
  sync per connection per day). `INTEGRATION_SCHEDULED_SYNC=0` disables them.
- The approvals page is the single place external writes happen. TikTok
  publishing remains on its own pre-existing approval flow until it is
  migrated onto the queue.

---

## ADR-0050 — A unified integration contract layered over the existing connection tables, not a rewrite

**Context.** Phase 1 asks for a single integration architecture covering
YouTube, TikTok, Google Search Console, websites and (net-new) WordPress,
with eight connection states, a capability/permission model, and real
diagnostics. What actually existed was four unrelated shapes: an
`OAuthConnection` row with a four-value `ConnectionStatus`
(`ACTIVE | EXPIRED | REVOKED | ERROR`), a separate `IntegrationHealth` row,
a `Website` row with a `verified` boolean and no status concept at all, and
— for WordPress — nothing. `/app/integrations` rendered a binary
`Connected` / outline badge computed inline in the page component, with no
health, no expiry, no capability list and no diagnostics.

**Decision.** Add a pure, additive contract layer rather than restructuring
the working OAuth code.

1. **`integrations/contract.ts`** holds the whole vocabulary and no I/O:
   the eight-state `ConnectionState`, a five-level `CapabilityLevel`
   (READ / DRAFT / WRITE / PUBLISH / DANGEROUS) with its approval policy,
   an `IntegrationDescriptor` registry for all five integrations, a pure
   `resolveConnectionState()`, `resolveCapabilities()`, and
   `diagnoseConnection()`. Being I/O-free makes every branch unit-testable
   without a database — the reason the state machine has 34 tests behind it
   on a machine with no Postgres.

2. **No schema change.** All eight states are _derived_ from rows that
   already exist. In particular `EXPIRED` vs `REAUTH_REQUIRED` — the one
   distinction users actually care about — is derived from whether a
   refresh token is stored, which the existing `refreshTokenCipher` column
   already tells us. Adding four enum values to `ConnectionStatus` would
   have forced a migration and a rewrite of `withFreshAccessToken`'s
   working status transitions to buy nothing.

3. **`IntegrationKey` is deliberately wider than Prisma's
   `IntegrationProvider` enum.** A website is a first-class integration
   with no credentials (its authorization is ownership verification, not a
   token), and WordPress will use Application Passwords rather than OAuth.
   Forcing either into the OAuth table to get a unified UI would be the
   wrong trade. The key type is therefore a separate union, and
   `center.ts` maps each key onto whichever table actually backs it.

4. **"Not configured" and "not connected" are different states, and
   "not implemented" is a third.** Conflating them is why a Connect button
   could previously lead to a failure — on staging, TikTok has no
   credentials, so its card offered a working-looking button. The
   Connection Center now distinguishes an operator problem ("this
   deployment is missing the credentials") from a user one ("you have not
   connected your account") from an honest product gap (WordPress:
   `implemented: false`, rendered as unavailable, never as a Connect
   button that goes nowhere).

5. **Diagnostics never say "something went wrong."** `diagnoseConnection`
   classifies conservatively — an unrecognised provider error is
   `PROVIDER`, never a guess at `AUTH` — and always returns a title, a
   plain-language explanation, a recommended action, a secret-scrubbed
   technical detail and a deterministic reference id. It is also
   defensive: a key with no descriptor degrades to a generic label rather
   than throwing, because a diagnostic function must never itself be the
   thing that crashes. (A test caught exactly that defect during this
   phase.)

6. **`integrations/probe.ts` makes connection testing real.** Until now
   `IntegrationHealth` was only ever written as a side effect of a sync, so
   a never-synced connection showed "never checked" with no way to check
   it. `testConnection()` makes one genuine, cheapest-available read-only
   call per provider (`youtube/v3/channels?part=id&mine=true` at 1 quota
   unit; `webmasters/v3/sites`; `user/info/?fields=open_id`), bounded by a
   10s timeout, refreshing first via the existing `withFreshAccessToken`,
   and records the true outcome. It never reports success it did not
   observe.

**Alternatives considered.** _Extend the `ConnectionStatus` enum to eight
values_ — rejected: a migration plus a rewrite of working refresh logic, to
persist what is already derivable. _Put websites and WordPress into
`OAuthConnection`_ — rejected: neither has OAuth tokens, and the table's
encrypted-token columns are non-nullable for a reason. _A model-driven
capability list_ — rejected outright; capabilities are a security boundary
and stay a hard-coded registry checked against actually-granted scopes.

**Consequences.** The Connection Center is one query pass and one pure
function away from any caller, so the agent tool layer (Phase 1 Part 13)
can reuse `resolveCapabilities` to decide what it is allowed to attempt,
rather than re-deriving permissions. `resolveConnectionState` is the single
place state is defined, so adding WordPress later means adding a descriptor
and a branch in `center.ts` — not another status vocabulary. The cost is
that `IntegrationKey` and `IntegrationProvider` must be kept in step by
hand; `diagnoseConnection`'s missing-descriptor fallback and `probe.ts`'s
missing-probe branch both exist so a mismatch degrades honestly instead of
crashing.

---

## ADR-0049 — Email+password auth, added alongside magic-link, reusing its verification-token mechanism

**Context.** The app shipped with passwordless-only auth: a magic-link
(Nodemailer/Resend) provider, Google OAuth, and a dev-only credentials
provider with no password check at all (`packages/services/src/auth/
providers.ts`). Asked for a real signup-with-password flow (name/email/
password/confirm, email verification before the account works, password
login, self-service password reset), while keeping every existing sign-in
path working unchanged.

**Decision.**

1. **No parallel token system.** Every "send a secure, single-use, expiring,
   verification link" requirement (post-signup verification, password
   reset) is already built — Auth.js's own email-provider callback marks
   `emailVerified` and establishes a session when a `VerificationToken` is
   redeemed. Both new flows call the same server-side `signIn('nodemailer',
{ email, callbackUrl })` the existing magic-link login already uses, just
   pointed at a different `callbackUrl` (`/app` for verification, `/app/
set-password` for reset — landing the now-authenticated user on a page to
   choose a new password). This means no new database table, and the
   existing 5/hour/address magic-link rate limit
   (`packages/services/src/auth/config.ts`) covers both new flows for free.
2. **Password hashing via Node's built-in `crypto.scrypt`, not a new
   dependency.** No `bcrypt`/`argon2`/scrypt-package existed in the repo.
   `packages/services/src/auth/password.ts` hand-rolls salted scrypt +
   `timingSafeEqual`, matching `crypto/tokens.ts`'s existing convention of
   hand-rolling crypto via `node:crypto` for exactly this class of need
   (AES-256-GCM token envelopes) rather than adding a package.
3. **A new `password` Credentials provider**, distinct from the existing
   dev-only `dev-credentials` (unchanged, still double-gated). Its
   `authorize()` rate-limits every attempt (success or failure) at
   10/hour/address — separate from and more generous than the magic-link
   limit, since mistyped-password retries are a normal pattern that sending
   an email doesn't have — and runs a real scrypt computation even when no
   user exists, so a nonexistent-email attempt doesn't respond measurably
   faster than a wrong-password one (a timing side-channel that would
   otherwise leak account existence). A correct password against an
   unverified account throws a distinct `EmailNotVerifiedError` (extends
   NextAuth v5's `CredentialsSignin`, which supports a `code` the client can
   read from `signIn()`'s result) rather than a generic failure, without
   leaking whether the email exists to someone who doesn't have the
   password.
4. **Every enumeration-sensitive response is now identical regardless of
   outcome.** Signup returns the same `{ ok: true }` whether the email was
   free, already had a password (nothing happens, no email sent), or was a
   magic-link-only account (password gets attached to the existing row, a
   verification email goes out); password-reset requests always return
   `{ ok: true }` too.

**Alternatives considered.**

- **A separate password-reset token table** — rejected: the existing
  `VerificationToken` + email-provider callback already does everything a
  reset token needs (single-use, expiring, proves inbox ownership), and a
  second table would mean a second thing to keep secure and tested for no
  functional gain.
- **bcrypt or argon2** — rejected in favor of the zero-dependency `crypto.
scrypt` approach, consistent with this codebase's repeated preference for
  hand-rolled crypto/parsing over a dependency (the Stripe REST client, the
  PDF writer, the cron parser, and `crypto/tokens.ts` itself all follow this
  pattern).

**Consequences.** `User.passwordHash` is a new, nullable, additive column
(migration `20260920120000_password_auth`) — every existing magic-link/
Google user is unaffected and simply has no password until they set one.
`docs/DEPLOYMENT.md`/`.env.example` need no new environment variables — the
new flows reuse `AUTH_SECRET`, `EMAIL_FROM`, `RESEND_API_KEY`/
`EMAIL_TRANSPORT` already required. Verified live against the real staging
deployment (Supabase-backed), not just `pnpm test`/`pnpm build` — see
`docs/STAGING.md` verification notes for the actual click-through result.

---

## ADR-0048 — Relocate the generated Prisma client in the web Docker build via a shell step, not a customized `output` path

**Context.** Building the staging web image for the first time ever (this
repo's Docker images had never actually been built end-to-end before —
Docker was unavailable in every prior review environment) surfaced a real
gap: `Dockerfile.web`'s runner stage copies `/app/node_modules/.prisma` as a
"belt & suspenders" measure for when Next's standalone file-tracing misses
Prisma's native query engine (a known, common gap for Prisma + Next.js
standalone). That path has never actually existed — pnpm's default
(non-hoisted) linker generates the Prisma client co-located inside
`@prisma/client`'s own version-hashed pnpm-store folder
(`node_modules/.pnpm/@prisma+client@<hash>/node_modules/.prisma/client`),
not at a flat root path.

The first fix attempted was Prisma's own documented remedy for this exact
Next.js-standalone-in-a-monorepo scenario: setting the schema generator's
`output` to a stable path (`../../../node_modules/.prisma/client`). It
worked for `packages/db` itself and appeared to work in an initial local
check, but rebuilding the **worker** image (previously untested this deep)
revealed the real cost: with a customized `output`, Prisma no longer
patches `@prisma/client`'s own `index.js`/`index.d.ts` to point at the
generated client, so `@growth-agent/db`'s `export * from '@prisma/client'`
stopped re-exporting any model types — breaking type imports in every
_other_ workspace package that imports a Prisma model type through
`@growth-agent/db` (`packages/services`'s tiktok/youtube/usage modules, at
minimum). This was caught only because the worker image had never
previously built far enough to exercise it, not by any test suite.

**Decision.** Revert the schema change; keep Prisma's default (co-located)
output entirely alone, so `export * from '@prisma/client'` keeps working
everywhere unmodified. Fix the actual runner-stage gap instead in
`Dockerfile.web`'s **build** stage, with a shell step appended to the
existing `RUN pnpm db:generate && pnpm --filter @growth-agent/web build`:
locate the real (hash-suffixed) generated client with `find` and copy it to
a stable, predictable path — resilient to the pnpm-store hash changing on
any dependency bump (unlike hardcoding that hash into a cross-stage
`COPY --from=build` instruction, which Docker can't glob) and touching
nothing outside this one Dockerfile.

That stable path is **not** `node_modules/.prisma` at the standalone root,
despite that being the runner's original (also never-worked) guess: a live
`/api/health` failure after deploying enumerated Prisma's actual runtime
search locations for a Next.js standalone build, and the one that's a
real Next.js-standalone convention is `<app-dir>/.prisma/client` — a
hidden folder _sibling to `server.js` itself_
(`apps/web/.prisma/client`), not anywhere under the standalone root's
`node_modules`. The runner's copy destination was corrected to match.
Two further sibling issues surfaced in the same live-deploy pass, both
fixed alongside this one: OpenSSL version detection needs the `openssl`
CLI installed in _every_ stage that touches Prisma, including both
runner stages (each a fresh `FROM node:...`, inheriting nothing from the
build stage) — without it, Prisma silently guesses the wrong target and
the mismatch only surfaces as this same "engine not found" class of error;
and the schema engine (needed only by `migrate deploy`, never invoked
during a normal build) has to be pre-fetched explicitly since it's a
separate binary from the query engine `generate` already fetches.

**Consequences.** No schema change, no risk to any other package's type
exports. The fix is Docker-build-local and disappears entirely if this
project ever moves off pnpm's isolated linker or off Next's standalone
output. None of these four issues (the missing path, the broken
re-export, the OpenSSL mis-detection, the wrong runtime search location)
were ever caught by `pnpm typecheck`/`pnpm build` — all four only ever
reproduced building and running a real, fresh Linux container, which is
why this phase's verification is a live `/api/health` check against the
actual deployed staging container, not just the usual gate commands.

---

## ADR-0047 — Typography brought in line with a visual reference (Hanken Grotesk / IBM Plex Mono) via self-hosted `next/font`, not a Google Fonts `<link>`

**Context.** A visual reference mockup for the product's screens ("Growth
Agent Screen Blueprint") used an indigo accent and a 0.6rem radius that, on
inspection, already matched the shipped tokens in
`packages/ui/src/styles.css` almost exactly (`--primary: hsl(244 76% 58%)` ≈
the mockup's `#4b46e8`; `--radius: 0.6rem` verbatim) — those were pulled from
the real design system when the mockup was built. Its typography (Hanken
Grotesk for display text, IBM Plex Mono for data/labels) was not: the app
loaded no custom font at all and rendered in the browser/Tailwind default
sans stack. Asked whether to bring the app closer to the mockup, the request
was scoped deliberately narrow — adopt the typography pairing, change no
component logic or route structure, and don't chase the mockup's more
elaborate layout/background treatment, since this codebase had just been
through a dedicated accessibility pass (Phase 29) that hand-tuned contrast
and ARIA behavior across the existing components.

**Decision.** Load both faces via `next/font/google` in
`apps/web/app/layout.tsx` (`Hanken_Grotesk` → `--font-sans`, `IBM_Plex_Mono`
→ `--font-mono`, both `display: 'swap'`), and map those CSS variables into
the shared Tailwind preset's `fontFamily.sans` / `fontFamily.mono`
(`packages/ui/src/tailwind-preset.ts`), each falling back to Tailwind's
previous default stack (`...defaultTheme.fontFamily.sans/mono`) so a build
that can't fetch the fonts degrades to exactly the prior look rather than
breaking. `font-mono` was already used at 34 existing call sites across
`apps/web` for IDs, timestamps and metric labels — wiring the variable
picks all of them up automatically, with zero component edits and zero
change to any feature.

**Alternatives considered.**

- **A `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` tag**
  (what the mockup itself uses, being a standalone artifact with no CSP) —
  rejected: the app's `next.config.mjs` CSP is `style-src 'self'
'unsafe-inline'` and `font-src 'self' data:` (docs/SECURITY.md §6,
  ADR-0029/M-1), so a Google Fonts `<link>` would either be silently blocked
  or require loosening the CSP to trust an external host — a real regression
  in the security posture for a purely cosmetic change. `next/font`
  downloads the font files at build time and serves them from the app's own
  origin, so `font-src 'self'` already covers it with no CSP edit.
- **Adopting the mockup's full visual language** (dotted grid background,
  denser stat/pane/pill component set, sticky blurred header) — deferred,
  not rejected outright: it would mean redesigning existing, already-audited
  components rather than layering a token, with a real risk of regressing
  Phase 29's contrast/ARIA fixes without a re-audit. Left as a possible
  future, explicitly-scoped follow-up rather than folded into this change.

**Consequences.** Visual-only change: no route, Server Action, schema, or
RBAC logic touched. Verified via `pnpm lint` (14/14) and
`pnpm --filter @growth-agent/web typecheck`, plus a full
`pnpm --filter @growth-agent/web build`. This sandbox's Node process
cannot complete the outbound TLS handshake to `fonts.gstatic.com` (`curl`
succeeds via the OS trust store; Node's own fetch fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` — a local network/proxy-trust quirk of
this environment, not a code defect), so `next/font`'s built-in
metrics-matched fallback face renders here instead of the real Hanken
Grotesk/IBM Plex Mono glyphs; the build itself still succeeds because
`next/font` treats a failed font fetch as non-fatal. In a normal deploy
environment with standard outbound TLS trust, the real fonts load exactly
as any other `next/font` integration.

---

## ADR-0046 — Final security review (Phase 31): risk-adjusted severity over raw CVE rating for dev-only findings; `--prod`-only dependency-audit scope re-confirmed deliberate, not widened; a real metering bug outranks every tooling-availability gap found; disaster recovery gets a documentation section, not a program

**Context.** The brief asked for a comprehensive pre-production security
review across 22 areas plus dependency/secret/SAST/DAST/container-scan
tooling, crawler-SSRF and AI-red-team re-verification, and a backup/
disaster-recovery review, classified BLOCKER/CRITICAL/HIGH/MEDIUM/LOW, with
an explicit "do not proceed to production with unresolved BLOCKER or
CRITICAL." This codebase already carries five prior dedicated security
audits (Phases 14, 18, 24, 25, plus the billing/AI production audits) — this
phase re-verified all of them against the current code (specifically
hunting for regressions from the five non-security phases since Phase 25),
actually ran every requested tool where the environment allowed it, and
found two real HIGH-severity application bugs neither prior audit had
surfaced. Full findings: `docs/FINAL-SECURITY-REPORT.md`.

**Decision.**

1. **A CVE's own severity rating is not automatically this report's
   severity rating — actual exploitability in this specific deployment is
   what's classified.** `pnpm audit` (including devDependencies) surfaced a
   CRITICAL vitest advisory and a HIGH vite advisory; both require a
   condition this codebase never triggers (`vitest --ui`, confirmed absent
   from every script and CI job) and neither ships in the production image
   (confirmed via `pnpm audit --prod`, which stays clean at the same 6
   pre-existing allowlisted advisories as every prior phase). Downgraded to
   a documented, deferred finding rather than reported as a production
   -blocking CRITICAL — the alternative (reporting CVE severity verbatim)
   would misrepresent risk in exactly the direction that erodes trust in a
   severity-classified report over time.
2. **The dependency-audit gate's `--prod`-only scope (`scripts/audit-allow.mjs`,
   set in an earlier phase) is re-confirmed correct, not widened.** A
   devDependency-only RCE has zero path into what actually ships; gating
   _deploys_ on test-tooling CVEs would train the team to routinely bypass
   or silence the gate, which is worse than the current, narrower, honestly
   -scoped one. The finding from item 1 is disclosed in this phase's report
   instead — visibility without conflating two different risk categories
   inside one gate.
3. **The `regenerateAssetAction` metering bypass is fixed by copying the
   sibling action's exact three-call pattern, not by inventing a shared
   abstraction.** `generateAssetsAction` in the same file already calls
   `enforceAiUserLimit` → `enforceUsage` → `recordUsage` correctly; the
   regenerate path (which makes an equally real
   `deps.model.generateObject` call) had none of the three, a direct
   violation of the master instruction's metering hard rule. A shared
   helper wrapping all three calls was considered and rejected: only two
   call sites exist, they already read clearly side by side, and a
   premature abstraction over two instances is exactly what this
   codebase's own "small modules over giant files... prefer maintainability
   over cleverness" rule warns against.
4. **Backup encryption moves from optional to enforced, closing a real gap
   between documented and actual behavior**: `docs/SECURITY.md` flatly
   claimed "backups encrypted" while `pg-backup.sh` only encrypted `if
BACKUP_GPG_RECIPIENT` was set — nothing enforced the claim.
   `BACKUP_GPG_RECIPIENT` is now a hard-required variable (`:
"${VAR:?msg}"`, matching the file's own existing convention for
   `DIRECT_URL`/`BACKUP_S3_BUCKET`) — the script now refuses to run rather
   than silently uploading a plaintext dump of the full tenant dataset. The
   alternative (leaving it optional and just fixing the doc's wording to
   say "optional") was rejected: the doc's claim was the more valuable
   thing to make true, not the more convenient thing to weaken.
5. **A webhook-signature-failure alert is added; a general
   failed-authentication-attempt alert is not**, despite both being
   flagged by the same research pass. The webhook case has one clear,
   already-existing code branch (`billing/webhook.ts`'s bad-signature
   throw) with an unambiguous meaning. This app's auth model (magic-link +
   OAuth, no passwords) has no equally clean definition of "a failed login
   attempt" — a bounced email, an OAuth `access_denied`, and a revoked
   -session replay are three different events that would need three
   different product decisions about what counts and how noisy the alert
   should be. Shipping a metric for an ill-defined event was judged worse
   than not shipping one; deferred pending that product decision.
6. **Disaster recovery gets one new documentation section
   (`docs/DEPLOYMENT.md` §18), not a full DR program.** The brief asked to
   "review" disaster recovery, and the review found a real gap (no RTO/RPO,
   no runbook, the single-host architecture's SPOF never explicitly
   accepted as a risk anywhere) — but building failover automation,
   multi-region infrastructure, or a tested runbook is a scoped
   infrastructure project, not something a review phase should attempt
   speculatively without the infrastructure this session has no access to
   test against (same constraint as Phase 30's staging runbook). The new
   section names the accepted risk explicitly, gives an honest RTO/RPO
   estimate from the _actual_ backup cadence already in place, and outlines
   the two realistic failure scenarios — proportionate to a review, not a
   build-out.
7. **`docs/DEPLOYMENT.md` §3 (Object storage) is corrected, not left as
   found**, because the security review's "File storage" area surfaced a
   real, load-bearing documentation inconsistency: §3 instructed a deployer
   to provision a bucket, IAM keys, and presigned-URL configuration for an
   application feature that `.env.example` and `docs/FORENSIC-AUDIT.md`
   already correctly document as **not implemented** — no code anywhere
   reads `S3_*`. Left uncorrected, a deployer following this runbook
   literally would provision and pay for infrastructure the app cannot use.
   The section now says so plainly and redirects the real backup-bucket
   guidance (least-privilege key split: write-only for the backup host,
   read-only for whoever restores) into the same place.

**Alternatives considered.** Treating every CVE at face-value severity
regardless of exploitability (rejected — item 1). Widening the dependency
-audit gate to include devDependencies (rejected — item 2). A generic
"security event" alert covering both webhook and auth failures under one
rule (rejected — conflates two different signal qualities; the auth side
isn't well-defined yet, and bundling it would either drown the
well-defined webhook signal in noise or force the same premature product
decision item 5 explicitly defers). Building actual multi-host failover or
running a real backup-restore drill this phase (rejected — no
infrastructure access in this session to build or test either against,
same disclosed constraint as Phase 30).

**Consequences.** No schema change. No new dependency (the transient
`detect-secrets`/`semgrep` install attempts were both uninstalled after
failing to run in this environment, never added to the project). Full
pipeline green: format/lint/typecheck 14/14, `packages/services` 681 tests
(unchanged — the fixes are a shell script, two Zod/JS validator tightenings,
one Server Action gaining three already-tested library calls, and one new
one-line metrics wrapper following an established untested-by-convention
pattern), the crawler/SSRF (75), AI red-team (34), and `security` (11) suites
re-confirmed green after the fixes, web build green. The new webhook
-signature-failure counter was verified live end-to-end (booted the built
app with fake Stripe keys, sent a deliberately bad-signature webhook,
confirmed `webhook_signature_failures_total{provider="stripe"}` appeared at
`/api/metrics`) rather than only type-checked. **No BLOCKER or CRITICAL
application-level finding survived risk-adjusted review** — both HIGH
findings are fixed by this phase; the report's go/no-go verdict is
unconditional-go on that basis, with the MEDIUM findings and the deferred
dev-tooling CVE bump listed as follow-up work, not blockers.

---

## ADR-0045 — Staging deployment (Phase 30): a runbook and config, not an executed deployment, because this session has no cloud/domain/third-party-developer access; Supabase + Upstash over a bespoke managed-service setup; a separate `docker-compose.staging.yml` file over a shared-base override; staging still runs `NODE_ENV=production` and full strict env validation

**Context.** The brief asked to "prepare and deploy a complete staging
environment" — configure web/worker/Postgres/Redis/object storage/an AI
provider/YouTube/TikTok/Search Console/Stripe test mode/email, HTTPS, a
domain, run migrations, start workers and scheduled jobs, and verify health,
background jobs, OAuth callbacks, webhooks, the crawler, AI, and billing. This
session has no cloud provider account, no domain, no Google Cloud/TikTok
Developer/Stripe/email-provider credentials, and no CLI for any hosting
platform — confirmed by checking for cloud CLIs (`aws`, `gcloud`, `flyctl`,
`render`, `vercel`, `doctl`, `heroku`, `railway` — none installed) and cloud
credentials in the environment (none present). None of that can be created by
this session on the user's behalf; asked, the user confirmed the runbook-only
path (write the exact deployment process; they or someone with real
infrastructure access executes it) rather than handing over live credentials
for this session to act on directly.

**Decision.**

1. **Deliver a runbook (`docs/STAGING.md`) plus the config it references,
   not a claim of an operational staging environment.** Fabricating a "staging
   is live" narrative when nothing was deployed would violate the master
   instruction's first hard rule (never fabricate; "no data" is a valid
   answer) applied to infrastructure state instead of analytics data. The
   runbook states this limitation in its own first section, not buried in a
   footnote, and every command in it is written to be run by a human with
   real access — none were run against real infrastructure while writing it.
2. **Supabase (Postgres) + Upstash (Redis)**, chosen when the user suggested
   Supabase specifically. Both already appear in this codebase's own
   `docs/DEPLOYMENT.md` as acceptable managed-service choices ("Neon, RDS,
   Cloud SQL, or Crunchy" / "Upstash, ElastiCache, MemoryDB"), both have
   usable free tiers appropriate for a staging environment's traffic, and
   Supabase's dashboard directly exposes the pooled + direct connection
   string pair Prisma needs (`DATABASE_URL` / `DIRECT_URL`) without extra
   configuration.
3. **Object storage is documented as out of scope for the application
   itself, not glossed over.** `.env.example`'s own "NOT IMPLEMENTED"
   section and `docs/FORENSIC-AUDIT.md` already establish that no code path
   reads `S3_*` — reports render on demand, nothing is uploaded anywhere.
   `docs/STAGING.md` says this plainly rather than inventing configuration
   for a feature that doesn't exist, and instead points the one genuine use
   of object storage on staging — the already-implemented Postgres backup
   script (`deploy/backup/pg-backup.sh`, a distinct `BACKUP_S3_*` variable
   set) — at Supabase Storage's S3-compatible endpoint or Cloudflare R2,
   marked optional since staging data is normally disposable.
4. **`docker-compose.staging.yml` is a deliberate, separate near-duplicate of
   `docker-compose.production.yml`**, not a shared base with an override
   layer. Docker Compose's `env_file:` path is a literal string baked into
   the compose file — reusing `docker-compose.production.yml` verbatim for
   staging would require a file literally named `.env.production` on the
   staging host containing staging secrets, which is confusing at best and
   a real risk at worst (a copy-paste of that file into an actual
   production host would silently work, applying staging config where
   production config was intended). A second, small compose file with a
   header comment enumerating the exact, exhaustive diff from production
   costs a little duplication in exchange for `git diff` being able to show
   the entire difference between the two environments' deploy config at a
   glance, and for the filenames themselves acting as a guard rail.
5. **Staging still runs `NODE_ENV=production` and the full strict
   `check-env.mjs`/`config/env.ts` validation path — no relaxation.**
   `check-env.mjs` already ships a `--allow-insecure` escape hatch (for a
   staging deployment with no TLS at all) and this codebase already has a
   `GROWTH_AGENT_ENV_STRICT=0` escape hatch (wired into the e2e test boot in
   Phase 27); `docs/STAGING.md` explicitly tells the reader not to use
   either one, because Google/TikTok OAuth callbacks require a real HTTPS
   redirect URI regardless, and because the entire point of a staging
   environment is to rehearse the exact validation path production will
   enforce — relaxing it here would let a real deployment blocker go
   undiscovered until the actual production release.
6. **OAuth apps stay in "Testing"/sandbox mode for staging, not verified/
   audited.** Google's sensitive-scope verification and TikTok's app audit
   are documented in `docs/DEPLOYMENT.md` as taking days-to-weeks and being
   necessary for production; both providers' Testing/sandbox modes work
   immediately for a small, explicitly-added set of test accounts, which is
   all a staging environment needs. `docs/STAGING.md` calls out exactly
   which capabilities each mode still gates (TikTok's audit is only required
   for `video.publish` and non-private posting) so this isn't mistaken for
   a full-parity substitute.
7. **A hand-verified check for `sk_live_`/`pk_live_` values is written into
   the runbook's own checklist**, not left as an unstated assumption, to
   make the brief's explicit "do not use production payment credentials"
   requirement something the deploying human can actually mechanically
   verify (`grep -E 'sk_live_|pk_live_' .env.staging` must print nothing)
   rather than a rule they have to simply remember.

**Alternatives considered.** Picking a specific PaaS (Fly.io, Render,
Railway) and writing provider-specific CLI steps (rejected — the user had no
preference ("your call"), this session cannot verify provider-specific CLI
behavior without an account on any of them, and the VPS + docker-compose
approach directly reuses this repo's existing, already-authored
`Dockerfile.web`/`Dockerfile.worker`/Caddy setup with zero new artifacts
beyond the staging-specific compose/env files). Silently attempting a partial
deployment against whatever might be reachable from this sandbox (rejected —
there is nothing reachable; no cloud account, no domain, no credentials exist
here at all, so there is no partial deployment to attempt, only documentation
to write).

**Consequences.** New files: `docker-compose.staging.yml`,
`.env.staging.example`, `docs/STAGING.md`; `.gitignore` gained a
`!.env.staging.example` exception (mirroring the existing `!.env.example`
one) so the template itself stays trackable while `.env.staging` (real
secrets) stays ignored under the existing `.env.*` rule; `docs/DEPLOYMENT.md`
gained a cross-reference. No application code changed — format/lint/
typecheck stayed fully cached (nothing invalidated). The new env template was
validated by filling it with well-formed placeholder values and running
`node scripts/check-env.mjs --file <filled-in-copy> --target all`, confirming
every variable name and validation rule matches the real script (`✓ ready`,
one expected warning for the optional AI-provider group) — this proves the
runbook's env var names are correct against the actual codebase, though it
cannot and does not prove a real deployment would succeed, since that
depends on real infrastructure this session cannot reach. **No staging
environment is operational as a result of this phase** — see
`docs/STAGING.md`'s own disclosure section for exactly what was and wasn't
done.

---

## ADR-0044 — UI/UX accessibility audit (Phase 29): `role="alert"`/`role="status"` on transient action results only, never on static persisted data; `Skeleton` bones are `aria-hidden`, one `role="status"` wrapper per loading view; `<div>`→`<h3>` for `CardTitle` accepted app-wide since it's a pure structural fix with no visual change; cursor pagination over a raw limit increase for the crawl issues list

**Context.** The brief asked for a full accessibility/usability audit across
desktop/tablet/mobile — navigation, forms, tables, dialogs, loading/empty/
error states, keyboard nav, ARIA, contrast, reduced motion — plus resilience
under missing data, API failure, thousands of records, slow AI, and a
running crawl, with an explicit instruction not to redesign, only to fix
what's necessary. No accessibility tooling or doc existed before this phase;
`docs/ARCHITECTURE.md`'s claim that Radix gives a WAI-ARIA foundation had
never actually been checked. Three parallel research passes (component
library, page-level states/forms, resilience under load) plus direct
verification (contrast-ratio arithmetic on the design tokens, a heading
-nesting check, the crawl-issues pagination gap, the agent-chat streaming
loop) found a bounded set of real, well-scoped issues rather than a
systemic redesign need — full findings and fixes are in
`docs/ACCESSIBILITY-AUDIT.md`.

**Decision.**

1. **`role="alert"`/`role="status"` only on transient, just-performed-action
   results — never on static data already present at page load.** A
   repo-wide grep for the app's error-styling class turned up ~85 matches;
   most were admin-table cells, persisted `lastError`/`failureReason`
   fields, and destructive-button styling — not messages. Applying
   `role="alert"` to those would misuse it (an assertive screen-reader
   interruption firing on every ordinary page render/list scroll, not just
   when something actually just happened). The ~30 sites that survived
   this filter are all `useState`/`useActionState`/`useTransition`-backed
   local result variables (`result`, `msg`, `state?.error`, `action.error`,
   named per-component, never a field read off a fetched list item) — each
   got `role="alert"` for its error branch and `role="status"` for its
   success branch, covering every form/Server-Action result in the app
   from a handful of shared local `Status` helper functions plus targeted
   per-site edits.
2. **`Skeleton` bones are `aria-hidden`; the announcement lives once on the
   loading view's container, not on every bone.** The two loading views
   that use `Skeleton` (`apps/web/app/(app)/app/loading.tsx`,
   `(admin)/admin/loading.tsx`) each render 4-8 `Skeleton`s at once — giving
   every one its own `role="status"` would announce "Loading" that many
   times per page load. `Skeleton` itself is now `aria-hidden="true"` by
   default (purely decorative), and each loading view wraps its whole
   group in one `role="status" aria-label="Loading page content"` div.
3. **`CardTitle` changes from `<div>` to `<h3>` app-wide (153 call sites),
   accepted as safe because it changes nothing visually** — Tailwind
   `className` drives 100% of its appearance, confirmed by reading a
   representative sample of usages (plain text, a `Badge`, a `Link`, none
   depending on block-level `<div>` layout behavior specific to that tag).
   `Badge`'s root also moves from `<div>` to `<span>` in the same pass,
   since several `CardTitle`s wrap a `Badge` and a `<div>` nested inside a
   heading is invalid HTML5 content — `Badge` was already visually
   `inline-flex`, so this is likewise a zero-visual-change fix. The one
   page where a `CardTitle` and a bare sibling `<h3>` coexisted (the crawl
   -issues severity groups) had that sibling bumped to `<h4>` to keep the
   nesting correct once `CardTitle` became a real heading.
4. **The crawl issues list gets cursor-based pagination, not a raised
   limit.** `listCrawlIssues` already computed and discarded a `nextCursor`
   before this phase; the page hard-capped at `{ limit: 100 }` with no way
   to reach the rest of a large crawl's issues. Rather than raise the cap
   (which only moves the same problem to a larger number, and risks a
   much heavier single response for a truly large crawl), the page now
   accepts a `?cursor=` param and renders a "Load more" link exactly
   matching the pattern already proven for YouTube/TikTok's video lists in
   this codebase — no new pagination mechanism invented, no client-side
   state. `listCrawlIssues` also now returns an exact `total` count (via a
   parallel `count()` alongside the existing `findMany`) so the heading can
   honestly report "N total, showing 100" instead of conflating the two —
   summing per-category counts as a cheaper approximation was rejected as
   a form of the "never fabricate a calculated_metric" violation the
   master instruction's hard rule 1 warns against, when an exact count is
   one cheap additional query away.
5. **The reduced-motion fix collapses durations to near-zero rather than
   disabling animation outright**, because Radix's `Presence` primitive
   (which drives `Dialog`/`DropdownMenu` exit unmounting) waits for a real
   `animationend`/`transitionend` event before removing content from the
   DOM; `animation: none` would suppress that event and could leave
   content stuck mounted after close. The standard, widely-documented
   `0.01ms !important` pattern (`packages/ui/src/styles.css`) keeps every
   event firing, just too fast to perceive.
6. **Light-mode `--muted-foreground` darkened from 47% to 40% lightness**
   (`packages/ui/src/styles.css`) after computing its actual contrast ratio
   by hand: ~4.70:1 against the background — technically over WCAG AA's
   4.5:1 floor for normal text, but with no margin for anti-aliasing or
   sub-pixel rendering variance. 40% lightness (same hue/saturation, so the
   color reads the same) gives ~6.1:1, a comfortable margin, with no other
   token needing the same treatment (every other pairing was verified
   comfortably clear of 4.5:1 by the same arithmetic).

**Alternatives considered.** A global toast/snackbar system for transient
feedback (rejected — no such primitive exists today, and building one plus
wiring every mutation site to it is a new feature, not a fix; item 1 above
already makes every existing inline result message screen-reader
-announced without new UI). Live polling for in-progress crawl status
(rejected — adds new real-time client behavior beyond an accessibility
fix, and can't be verified against a real running crawl without a live
DB/Redis/worker in this environment). A cancel button + stall-timeout for
the agent chat stream (rejected — a new feature/failure-mode addition, not
a fix for something broken in normal operation; a "safe" stall threshold
can't be validated without live AI provider traffic, and no AI key is
configured here).

**Consequences.** No schema change. No new dependency. Full pipeline
green: format/lint/typecheck 14/14, `packages/services` 681 tests
(unchanged — no service test asserted the exact shape `listCrawlIssues`
gained a field on), web build, and a DB-less Playwright run matching
Phase 27's 61/88 baseline exactly (two transient failures on a first pass,
under full-suite worker contention, both confirmed passing in isolation
and on a clean re-run of the full suite — not a regression). One existing
e2e assertion (`apps/web/e2e/failures.spec.ts`'s 2,000-issue test) was
updated to assert the new paginated heading text and a working "Load more"
link, since its old assertion could never have passed against either the
old 100-item cap or the new pagination. **Verification limit, same as
Phases 27-28**: every fix touching an authenticated surface (settings,
the TikTok publish dialog, the crawl-issues pagination UI, the notification
bell) could only be verified by type-checking, the existing DB-less e2e
suite, and direct inspection of the compiled CSS/HTML for the public pages
— not by driving the actual authenticated UI live, since this machine's
Docker Desktop still cannot start (virtualization disabled in firmware).
See `docs/ACCESSIBILITY-AUDIT.md`.

---

## ADR-0043 — Performance and load testing (Phase 28): bounded per-check timeouts over trusting `Promise.all`; `Promise.allSettled`-style parallelization for independent AI calls, not `Promise.all`; reuse `ConcurrencyLimiter` over hand-written batch SQL; `cache()` for per-request auth; hand-authored `CREATE INDEX` accepted, hand-written batch SQL rejected

**Context.** The brief asked whether the system can support real users:
measure frontend/API/DB/Redis/AI/crawler/background-job performance,
load-test eight workflows at 10/50/100/500 concurrent users, find
bottlenecks without just adding infrastructure, and optimize. The same
firmware-level virtualization block from Phase 27 (`wsl --install` still
fails with `HCS_E_HYPERV_NOT_INSTALLED`, re-confirmed at the start of this
phase) meant no live Postgres or Redis, blocking authentic load testing of
every DB-dependent workload in the brief's list. Rather than skip live
testing, three methods were combined: real `autocannon` runs against every
endpoint reachable without a database (the landing page, `/api/health`);
one bug reproduced by actually booting the built app with the DB
unreachable and reading server logs, not just source; and a static
architectural review (two parallel research passes over DB query patterns
and crawler/AI/Redis/worker concurrency) translated into a disclosed,
projected-capacity discussion for everything that needs a live DB to
measure for real. `docs/PERFORMANCE-REPORT.md` has the full results.

**Decision.**

1. **Every DB-touching health check gets an explicit bounded timeout,
   because `Promise.all` alone does not protect against a hung dependency.**
   Booting the app with Postgres unreachable and curling `/api/health`
   repeatedly showed a real, reproducible ~4s stall: three sequential Prisma
   "can't reach database server" errors in the server log, even though
   `runHealthChecks` already calls `checkDatabase`/`checkExternalIntegrations`/
   `checkWorker` via `Promise.all`. `Promise.all` only parallelizes at the JS
   level; the Prisma engine's own connection-pool/retry behavior serialized
   underneath it. `checkRedis` already avoided this via `pingRedis`'s
   `Promise.race` timeout (`packages/services/src/observability/redis.ts`) —
   the fix mirrors that exact pattern for the other three checks
   (`packages/services/src/observability/health.ts`), each now bounded to
   2.5s and reporting `{ state: 'down', detail: '... timed out' }` instead of
   hanging. Verified live: post-fix, the same unreachable-DB boot now
   responds in ~2.5-2.8s once (not ~4s recurring), and an `autocannon -c 50`
   run against `/api/health` under the same conditions shows a p97.5 of
   ~2.8s with zero unbounded requests.
2. **Independent AI calls are parallelized with per-call error isolation
   preserved, not with a bare `Promise.all` that would let one failure sink
   the rest.** The Growth Agent orchestrator's up-to-5 capability calls
   (`agent/orchestrator.ts`) and content-generation's per-type
   `generateObject` calls (`content/generate.ts`) were serial `for` loops —
   confirmed, in both cases, that no iteration depends on another's output
   within the same turn, only on a shared pre-computed context. Both became
   concurrent maps over the same per-item try/catch (with a template
   fallback already in place for content-generation) that existed before,
   so a single capability or asset-type failure still degrades gracefully
   instead of failing the whole turn — the isolation was preserved by
   keeping each iteration's own error handling internal to the mapped
   function, not by switching combinators.
3. **The crawler's two `finalize()` N+1 loops reuse the existing
   `ConcurrencyLimiter` (`seo/rate-limiter.ts`) instead of hand-written batch
   SQL.** Both loops were extracted into new, exported, independently unit
   -tested functions (`persistInboundLinkCounts`, `persistCrawlIssues` —
   `seo/crawler.ts`), each bounding concurrent writes at 10 instead of
   awaiting one row at a time. A `db.crawlPage.updateMany`/raw
   `UPDATE ... FROM (VALUES ...)` batch statement was considered and
   rejected: there is no live Postgres in this environment to validate its
   syntax or type-casting against, and getting a hand-written batch
   statement wrong silently corrupts crawl data — reusing an existing,
   already-integrated primitive at a bounded concurrency carries
   categorically less risk than authoring new untested SQL. New
   `seo/crawler.test.ts` (previously nonexistent — only the Postgres-gated
   `crawler.integration.test.ts` touched this code) unit-tests both
   functions against a fake `Db`, including that a single failing row never
   aborts the batch and that concurrency stays bounded.
4. **A single `CREATE INDEX` migration is hand-authored without a live DB;
   a batch-write SQL statement is not — the risk profile is not the same.**
   `Recommendation`'s existing `@@index([organizationId, domain, status])`
   doesn't serve the highest-volume real read paths (`agent/capabilities.ts`,
   `reports/facts.ts`), which filter by `organizationId` alone and sort
   `priorityScore desc, createdAt desc`; grepping every
   `db.recommendation.findMany` call site confirmed this before adding
   `@@index([organizationId, priorityScore, createdAt])`. Every existing
   migration in this repo already follows one plain
   `CREATE INDEX "name" ON "table"("col", ...)` pattern with no data
   transformation — a single additive statement in that exact shape carries
   materially lower syntax/type risk than a multi-row upsert, which is why
   it was hand-authored here (Phase 24's precedent: `pinning-proxy.ts` was
   also hand-written without a live integration test where risk was assessed
   as low) while item 3's batch-write approach was not.
5. **`requireUser()`/`requireActiveOrg()` (`apps/web/src/lib/auth.ts`) are
   wrapped in React's per-request `cache()`**, the same primitive already
   used once for `getCorrelationId` (Phase 13,
   `apps/web/src/lib/observability.ts`) — every `/app/*` navigation called
   both once per layout and once per page, duplicating the session-revocation
   query and the org-membership lookup on every request. `cache()` was
   chosen over a manual per-request memo map because it is already an
   established pattern in this codebase, needs no new plumbing, and scopes
   correctly to one request without leaking across requests.
6. **The Subscription-row duplicate query is deduped by widening an
   existing read, not by adding a new shared cache.** `resolveEntitlements`
   (`billing/entitlements.ts`) already read the org's `Subscription` row for
   its `tier`; `usage/check.ts` and `usage/summary.ts` each ran a _second_,
   separate `Subscription` query for `currentPeriodStart`/`currentPeriodEnd`
   moments later. `resolveEntitlements`'s `select` now also fetches those
   two fields and returns them on `ResolvedEntitlements` (additive — the six
   other call sites that don't use them are unaffected), and both call sites
   now read the period from that one result instead of querying again.

**Alternatives considered.** Adding a Redis-backed cache layer for
entitlements/org-context/dashboard aggregates (rejected for this phase — no
cache-invalidation strategy has been designed for any candidate surface, and
designing one is a feature-sized decision, not a performance-phase patch,
plus it can't be tested end-to-end without live Redis here). Tuning BullMQ
per-queue `concurrency`/`limiter` options now that a bottleneck is suspected
(rejected — doing so without real job-duration/queue-depth telemetry, which
this environment cannot produce, risks the exact "increase infrastructure
without identifying the underlying problem" anti-pattern the brief warned
against). Clustering `next start` / running multiple instances in response
to the measured single-process ceiling (rejected for the same reason — a
deploy-time decision documented in the report, not a code change here).

**Consequences.** No public schema changed beyond one additive index. No
new dependency (`autocannon` was invoked transiently via `npx`, never added
to any `package.json`). Full pipeline green: format/lint/typecheck 14/14,
`packages/services` 681 tests (+10: 3 new health-timeout tests, 7 new
`crawler.test.ts` tests), script tests, tenant-scope and audit-allow gates,
web build. **A full live load test of every DB-dependent workload the brief
named (auth, dashboard, analytics, SEO project, crawl creation, AI requests,
reports, billing) was not possible in this session** for the same firmware
reason as Phase 27 — disclosed in `docs/PERFORMANCE-REPORT.md` alongside the
architectural analysis used in its place, pending either that firmware
change or a CI run against a real Postgres/Redis.

---

## ADR-0042 — Full E2E testing (Phase 27): `/api/health` must never depend on strict-mode config validation; the existing `GROWTH_AGENT_ENV_STRICT` escape hatch is the fix for e2e/CI boot, not a new one; direct Prisma seeding for provider states no automated test can reach

**Context.** Building the full journey/failure/security Playwright suite the
brief asked for started with standing up the local dev stack and running the
_existing_ e2e suite exactly as `playwright.config.ts` and
`.github/workflows/ci.yml`'s `e2e` job already configure it — not just
reading the config. That surfaced a real, previously undetected regression:
`GET /api/health` returned 500 under that exact boot (`NODE_ENV=production`,
`NEXT_PUBLIC_APP_URL=http://localhost:*`, no `AUTH_URL`/`ENCRYPTION_KEY`/
sign-in path), reproduced by booting `next start` directly and reading the
stack trace, not inferred. Root cause: `packages/services/src/config/env.ts`
(Phase 19's prod-strict boot validation) throws at module-import time, and
`packages/services/src/index.ts`'s eager `export * as config from
'./config/env.js'` means the first route whose bundle imports
`@growth-agent/services` for any reason (`/api/health`, for its DB/Redis
checks) poisons that module in Node's module cache for the rest of the
process. This directly broke Phase 13's own documented contract
(`/api/health`, always 200) and would have made the existing
`api.spec.ts`/`smoke.spec.ts` health assertions — and CI's own
docker-job healthcheck-polling loop — fail. This repo has never been pushed
anywhere (no commits), so CI had never actually run this to catch it before
now.

**Decision.**

1. **Fix the e2e/CI boot with the escape hatch `config/env.ts` already
   ships**, rather than inventing a new one. `GROWTH_AGENT_ENV_STRICT`
   already existed, gating only the footgun/required-field rules (type
   validation of whatever _is_ provided always runs) — nothing was setting
   it. Added `GROWTH_AGENT_ENV_STRICT: '0'` to
   `apps/web/playwright.config.ts`'s `webServer.env`, which CI inherits
   automatically since its `e2e` job launches the same Playwright config.
   The alternative — relaxing `config/env.ts`'s validation logic itself, or
   hand-supplying a fake-but-valid `https://` `AUTH_URL` to satisfy the
   strict path — was rejected: the strict path exists specifically to catch
   a genuinely misconfigured _deployment_, and weakening it (or faking
   values a real check would still reject in spirit) to make a _test_ boot
   pass would defeat its purpose for the one case it matters most.
2. **`/api/health`'s own resilience is a separate, permanent fix, independent
   of (1).** Fix (1) makes e2e boot cleanly, but a genuinely misconfigured
   production deployment would still 500 on its own health check today,
   which is backwards for the one endpoint whose job is staying diagnosable
   when something else is broken. `apps/web/app/api/health/route.ts` now
   loads every import it needs dynamically, inside a `try` — the same
   "nested import to control evaluation timing" pattern
   `instrumentation.ts` already uses (there, to keep `bullmq`/`ioredis` out
   of the edge bundle) — turning a config-load failure into one more
   `checks[]` entry in the normal 200 body instead of an uncaught 500.
   Scoped to this one route: every other route still fails loudly on a
   broken prod config, which remains correct — only the route whose entire
   contract is "always 200" gets the extra resilience.
3. **Provider states no automated test can reach (a completed Google/TikTok
   OAuth consent, a paid Stripe subscription) are exercised by seeding the
   row a real flow would have produced, directly via Prisma — never by
   attempting to automate the provider's own hosted UI.** Automating a real
   OAuth consent screen or Stripe Checkout needs live credentials this
   environment doesn't have, and scripting a real provider's UI in an
   automated test risks violating that provider's own automation policy.
   The "Connect" buttons are instead verified to actually reach the real
   provider's authorize host (proving our own redirect-construction code
   path works), and the _connected_/_paid_ application state is exercised
   by seeding exactly the row a completed flow would write — the same
   honesty convention `docs/QA.md` already used for its "N/A" entries,
   applied to a partially-automatable case instead of a fully-N/A one.

**Alternatives considered.** Skipping the health-check fix and just
special-casing the e2e boot (rejected — Fix 1 alone leaves a real production
health-check gap unresolved, and the two fixes are cheap and independent).
Mocking a fake OAuth/Stripe provider server for the e2e run (rejected as
disproportionate to this phase — no such seam exists anywhere in the
codebase today, confirmed by a repo-wide search, and building one is a
bigger infrastructure investment than a testing phase should introduce
un-asked; direct seeding is simpler, matches the existing
`authed.spec.ts` convention of writing session state directly rather than
driving a real login, and is easy to audit since it's just Prisma writes in
the test file itself).

**Consequences.** No public schema changed. No new dependency. A fresh
`pnpm --filter @growth-agent/web test:e2e` run without a database — the only
verification possible on this machine, see below — passed all 61
non-DB-dependent tests (including the `/api/health` case Fix 2 targets) and
saw the remaining 27 (four pre-existing plus 23 new) self-skip cleanly
rather than error, confirming the new spec files are structurally sound.
**A full authenticated run against a real Postgres was not possible in this
session**: `wsl --status` showed no installed WSL distribution, and
`wsl --install` itself failed with `HCS_E_HYPERV_NOT_INSTALLED` —
virtualization is disabled in this machine's firmware, fixable only by a
physical restart into BIOS/UEFI setup, which nothing available to this
session can do. This is disclosed, not silently skipped: `docs/QA.md` and
`docs/E2E-TESTING.md` both record that the new journey/failure/security
specs are unverified end-to-end pending either that firmware change or a CI
run, where Postgres is already provisioned exactly as
`.github/workflows/ci.yml`'s `e2e` job describes.

---

## ADR-0041 — Data accuracy validation (Phase 26): malformed-response guard on incomplete-but-successful analytics responses; `null` (never `0`) for an uncomputable aggregate; UTC getters for any date parsed from a date-only string

**Context.** A traceability audit (Source → API field → DB field →
Calculation → Display) of every displayed metric across YouTube, TikTok,
Google Search Console, the SEO crawler, revenue tracking, and the reporting
engine's growth-percentage math found eight defects, none in the core
calculation logic itself (every derived-metrics function traced was already
a correct, pure computation) — all eight were in how "missing," "zero," and
"estimated" are distinguished at the write or display boundary, plus a set
of calculation functions that had never been checked against a hand-computed
expected value. One of those checks (`monetization/revenue.ts`'s
`recurringMonthlyByCurrency`) caught a live, previously undetected
timezone-dependent bug the moment a hand-verified test was written against
it — direct validation that the "compare against a manually verified
calculation" requirement in the brief is not a formality.

**Decision.**

1. **A successful API response missing a column the app explicitly
   requested is malformed data, not a legitimate zero.** YouTube's
   `syncAnalytics` now verifies every requested `CHANNEL_METRICS` name has a
   matching column in the response before writing any row, throwing the
   module's existing `MalformedApiDataError` (already the documented
   contract for schema-invalid data: mark the run `FAILED`, write nothing
   partial) rather than silently defaulting the missing metric to `0` for
   every row. This generalizes the pattern `estimatedRevenue` already used
   correctly (absence ⇒ `null`, since that one column is legitimately absent
   for a non-monetized channel) to the columns whose absence has no
   legitimate explanation.
2. **An uncomputable aggregate is `null`, never `0`.** Search Console's
   aggregate CTR/position (our own impression-weighted rollup, not Google's
   per-row value) now returns `null` — not `0` — when there are zero
   impressions to average, consistent with how `reports/sections.ts`'s
   `pctChange` already returns `null` (not `0` or `Infinity`) on a
   zero-baseline percentage change. The recurring theme across every fix in
   this phase: a computed value's "not applicable" state must be
   representable and distinct from every value the computation could
   legitimately produce — `0` fails that test the moment `0` is also a real
   possible answer (a real zero-impressions day, a real zero-subscriber
   channel), which is why `null` is the standing convention for "nothing to
   compute from," not a sentinel number.
3. **Any date derived from a date-only string (`"YYYY-MM-DD"`) must use UTC
   getters (`getUTCFullYear`/`getUTCMonth`/...), never local-time getters.**
   `new Date('2026-01-01')` parses as UTC midnight per spec; reading it back
   with `.getMonth()`/`.getFullYear()` (local-time getters) silently shifts
   the effective calendar date backward by up to a day — and, at a month or
   year boundary, backward by a whole month or year — on any server whose
   timezone sits behind UTC (all of the Americas). This is exactly what
   corrupted `recurringMonthlyByCurrency`'s "months spanned" calculation
   while the function's own `byMonth` grouping, two lines away, was already
   doing this correctly via `toISOString().slice(0, 7)`. The fix is the
   narrow one (switch the one broken call site to UTC getters, matching the
   convention already used elsewhere in the same file) rather than a
   project-wide date-handling library, since a grep of `packages/services`
   confirmed no other call site mixes the two conventions.

**Alternatives considered.** Treating a missing analytics column as `null`
per-field instead of throwing (rejected for the 8 core metrics — a
day-level `YouTubeMetric` row is meant to represent "the API had data for
this day," and a row with some real fields and some silently-absent ones is
a worse data shape than no row at all; `estimatedRevenue`'s existing
per-field `null` stays as the one deliberate exception, since its absence
_is_ legitimate). Making TikTok's `createTime` nullable at the schema level
to let a missing `create_time` through cleanly (rejected — a real Prisma
migration for one defensive edge case TikTok's API essentially never
triggers; skipping the one bad row is smaller and just as correct). A
generic date-utility wrapper enforcing UTC everywhere (rejected as
disproportionate to a single confirmed call site; noted as the pattern to
watch for if a similar bug turns up elsewhere).

**Consequences.** No public schema changed except
`PerformanceSnapshotData.totals.{ctr,position}` → nullable (Zod-level only;
this data is stored as untyped `Json`, no Prisma migration). No new
dependency. `pnpm --filter @growth-agent/services test` — 671 tests (654 +
17), zero regressions, confirming every fix only changes output for data
that was already wrong or already missing. See `docs/DATA-ACCURACY.md` for
the full per-metric traceability tables and the file:line evidence for each
finding.

---

## ADR-0040 — AI red team (Phase 25): trust hierarchy folded into the existing shared clause; output scrubbing as a generic deep-walk utility; forced confirmation as a post-parse normalizer, not a stronger schema

**Context.** Phase 25 attacked the AI layer as a malicious user would —
prompt injection, secret exposure, cross-tenant access, tool manipulation,
and instruction hijacking — reproducing each attack as a test against the
real code before deciding what, if anything, needed to change. Most named
attacks were already closed structurally (no model-driven tool-calling loop,
org-scoping from server context never from input or model output, no
write/publish tool anywhere in the agent layer) and are pinned by new tests
rather than new code. Three gaps needed a fix: no prompt stated the
SYSTEM/DEVELOPER/USER/EXTERNAL-DATA hierarchy the brief asks for by name;
`scrubSecrets` (used for logs and `ErrorEvent` context since Phase 13) was
never applied to what an agent actually persists or returns; and
`proposedActions[].requiresConfirmation` on a successful model synthesis was
never re-checked in code, so an injection convincing the model to emit
`requiresConfirmation: false` on an external action would pass grounding
untouched (`checkGroundingFields`'s `flatten()` never examined that field).

**Decision.**

1. **Extend the existing `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` in place, rather
   than adding a second constant or touching every agent's prompt
   individually.** The clause is already imported by every model-facing
   system prompt in the codebase (verified: 100% coverage before this phase
   started). Rewriting its text to state the trust hierarchy by name and add
   anti-extraction / anti-authority / anti-scope-widening language is a
   single-file change that reaches all ~11 prompts at once, with no risk of
   missing one the way a per-agent edit could.
2. **A generic `scrubModelOutput<T>(value: T): T` deep-walk utility in
   `packages/services/src/agents/output-scrub.ts`, reusing `scrubSecrets`
   rather than reimplementing secret detection**, applied by each agent to
   its own final output right before persistence/return. A generic
   value-shape walker (string leaf → `scrubSecrets`, recurse into
   arrays/objects, pass `Date` through) is simpler and more future-proof than
   patching individual string fields per schema — a new field on any agent's
   response schema is covered automatically, with no per-field allowlist to
   keep in sync.
3. **A post-parse normalizer (`finalizeBlocks` in `agent/orchestrator.ts`),
   not a stronger Zod schema, for the forced-confirmation invariant.** Zod
   cannot cleanly express "if `kind === 'external'` then `requiresConfirmation`
   must be `true`" as a parse-time constraint without a custom `.transform`/
   `.superRefine` that duplicates the same logic anyway; a small, explicitly
   commented function applied identically to both the model path and the
   deterministic fallback is easier to read, easier to test in isolation, and
   makes the invariant visible at the one call site that matters
   (`synthesize()`) rather than buried in schema internals.

**Alternatives considered.** A separate "meta" system-prompt constant just for
the trust hierarchy (rejected — two constants to keep in sync is strictly
worse than extending the one already wired everywhere). Scrubbing only the
specific fields known to be user-visible today (rejected — brittle against
schema growth; a generic deep-walk costs nothing extra since agent outputs
are already small, schema-validated JSON). Gating `requiresConfirmation` at
the UI layer only (`message-blocks.tsx` already renders `external` actions as
inert text with no handler) instead of in the orchestrator (rejected — the
UI having no handler today is not a security control; the moment a future
change wires one up, it must read a value the model cannot have falsified,
which means the invariant belongs in the data, not in whichever UI happens to
render it).

**Consequences.** No public schema changed (`GrowthAgentResponse`,
`ProposedAction` untouched). No new dependency. The scrub and the
forced-confirmation normalizer are purely additive — they only change output
for content that was already secret-shaped or already violating the
confirmation invariant, confirmed by re-running the full existing test suite
(654 tests, zero regressions) after wiring both in. See
`docs/AI-SECURITY-AUDIT.md` for the full attack-by-attack matrix, the fixes,
and the residual-risk list (grounding checks citation validity and banned
phrasing, not semantic relevance; a determined multi-turn jailbreak against
the underlying provider can't be fully prevented by prompt wording alone,
which is why the real backstops are architectural; the secret-scrub regexes
are best-effort, not exhaustive).

---

## ADR-0039 — Crawler security audit (Phase 24): numeric-groups embedded-v4 detection; a linear glob matcher over backtracking regex; a local pinning CONNECT proxy for the renderer

**Context.** An adversarial audit of the crawler (`packages/services/src/seo/*`

- `apps/worker/src/seo/playwright-renderer.ts`) found and reproduced, live,
  against the real code, three exploitable gaps in defenses the codebase already
  believed it had: (1) `isBlockedIp`'s embedded-IPv4-in-IPv6 detection was a
  string regex on a dotted quad, but Node's `URL` parser canonicalizes
  `::ffff:127.0.0.1` to the hex-group form `::ffff:7f00:1` — the dotted quad is
  gone from the string — so a mapped/6to4/NAT64 literal (e.g.
  `http://[::ffff:169.254.169.254]/`) sailed straight through to cloud metadata;
  (2) `robots.ts` and `url.ts` both translated a `*`-wildcard pattern into a
  backtracking regex, and a ~40-character adversarial robots.txt `Disallow`
  value (100% attacker-controlled — it's the crawled site's own file) hung the
  process indefinitely, freezing every concurrently-running crawl job in the
  same worker process (`concurrency: 4`, single Node event loop); (3) the
  headless-render path validated a subresource URL with `assertSafeUrl` in a
  `page.route` interceptor but let Chromium make the actual TCP connection with
  its own, unpinned DNS resolution — the exact resolve→connect TOCTOU the plain
  `fetch.ts` path already defeats by pinning the socket.

**Decision.**

1. **Decode embedded IPv4 from the address's numeric 16-bit groups**
   (`expandIpv6`'s output), not from a string regex on the address text. This
   is correct regardless of which spelling (dotted or hex-group) the string
   arrived in, since `expandIpv6` already normalizes both to the same numeric
   groups before any embedded-v4 check runs. Covers IPv4-mapped,
   IPv4-compatible, NAT64, and 6to4.
2. **Replace both wildcard-to-regex translations with one linear matcher**
   (`pattern-match.ts` `wildcardMatch`, the classic two-pointer glob
   algorithm) rather than trying to harden the regex (e.g. length caps,
   possessive quantifiers aren't available in JS regex, or a regex complexity
   linter). A linear algorithm has no backtracking to exploit in the first
   place, needs no escaping step (it was removed entirely from both call
   sites), and is a smaller amount of code than the regex-translation it
   replaced.
3. **A local pinning CONNECT proxy, not a per-render browser relaunch or
   `--host-resolver-rules`.** Chromium supports pinning hostnames to IPs via a
   launch-time `--host-resolver-rules` flag, but that requires knowing every
   hostname a page will request _before_ the page loads — subresource hosts
   (CDNs, fonts, analytics, images) are discovered dynamically as the page
   renders, so a static launch-time rule set cannot cover them. A local
   forward proxy resolves this correctly: Chromium asks the proxy to CONNECT
   (HTTPS) or forward (plain HTTP) by hostname for each request as it happens,
   and the proxy performs the one resolution that matters and pins the
   upstream socket to it — dynamically, per request, with no advance
   knowledge needed. Playwright supports a **per-context** proxy override in
   Chromium, so the existing singleton browser instance in
   `playwright-renderer.ts` needed no change; only `newContext(...)` gained
   the option. The proxy never terminates TLS (CONNECT just splices bytes),
   so there is no certificate handling to get wrong and no dependency added.

**Alternatives considered.** Regex length/complexity caps for the ReDoS fix
(rejected — brittle, and a correct linear algorithm is not meaningfully more
code). Network-level egress firewalling for the renderer TOCTOU (the
already-documented, still-outstanding "network-isolated egress pool" — this
would also close the gap, but is an infra task with no timeline; the pinning
proxy closes it in application code today without waiting on that). A
per-request-relaunched Chromium process with per-launch `--host-resolver-rules`
scoped to only the top-level navigation host (rejected — does not cover
dynamically-discovered subresource hosts, and adds real latency per render).

**Consequences.** No public API changed in `ssrf.ts` (pure bugfix inside
`isBlockedIp`). `robots.ts`/`url.ts` lost their regex-escaping step entirely —
net simplification. `playwright-renderer.ts` gains one new local dependency
(the proxy it starts itself, in-process, no new npm package) and one new
teardown step (`proxy.stop()` in `close()`). A `clusterBySimhash` O(n²)
bugfix (bucket by simhash prefix) rode along as a cheap, low-risk HIGH finding
in the same phase. See `docs/CRAWLER-SECURITY-AUDIT.md` for the full
evidence, fix, and test for every finding, and the residual-risk list (exotic
IPv6 transition mechanisms not exhaustively covered; the proxy cannot
byte-cap HTTPS traffic without terminating TLS; the LSH-bucketing trade-off;
the crawl-size-ceiling-vs-plan-budget gap left for a future phase).

## ADR-0038 — Production billing (Phase 23): AI budget is a pre-flight exhaustion gate, not a reservation; crawl-pages gated the same way; payment-failure reuses the notification system

**Context.** The subscription system (ADR-0010 / ADR-0025, operator's "Phase
10") was already production-shaped — a config plan catalog, a hand-rolled Stripe
REST gateway + `NullBillingGateway`, checkout / portal / plan-change / cancel /
resume, a signature-verified doubly-idempotent webhook, an `Entitlement`
overlay, a nightly reconcile, and server-side `usage.enforceUsage`. A Phase-23
audit against the source found three enforcement gaps and one visibility gap:
`AI_TOKENS` was recorded but never enforced; `CRAWL_PAGES` was recorded but
never gated pre-flight; the YouTube / TikTok / monetization / SEO-agent Server
Actions enforced neither AI meter (only the Phase-22 per-user rate limit); and a
failed payment produced only an audit row, nothing the owner would see.

**Decision.**

1. **`AI_TOKENS` is enforced as an exhaustion gate, not a reservation.** A
   call's token count is unknowable before the call returns, so
   `usage.enforceAiBudget` checks `AI_TOKENS` with `amount: 1` — it blocks the
   _next_ request once `used >= limit`, and `AI_REQUESTS` (which is reservable)
   with `amount: 1`. One helper, wired at `/api/agent/stream` (replacing the
   bare `enforceUsage(AI_REQUESTS)`) and the four analyst Server Actions.
2. **`CRAWL_PAGES` is gated the same way** — `enforceUsage(CRAWL_PAGES, 1)` at
   `startCrawlAction` blocks a new crawl when the page budget is spent; the
   exact `pagesCrawled` is still recorded after the crawl.
3. **Payment-failure visibility reuses the existing notification system** — no
   new billing state, no schema change. `invoice.payment_failed` / a move into
   `PAST_DUE`|`UNPAID` → an org-wide `WARNING` `Notification` (idempotent on
   `dedupeKey`); `invoice.payment_succeeded`|`paid` → an `INFO` recovery notice.
   `createNotification` never throws, so it cannot break webhook processing.

**Alternatives considered.** A token _reservation_ with a rolling estimate
(rejected — the estimate is always wrong, and a reservation you cannot true up
is just a worse gate; every other post-hoc counter meter already behaves as an
exhaustion gate). Clamping a crawl's `maxPages` to the remaining budget
(deferred — useful, but it is a crawl-planning change, not a billing one; the
gate is the safety net). A dedicated `BillingAlert` model + a billing-events
worker queue (rejected — the notification system already does dedupe + email
fan-out + an in-app inbox; a second mechanism is pure duplication). Enforcing
the AI meters inside each analyst _job_ rather than the Server Action (rejected —
the jobs also run from the worker/automation with no user to 429; the Action is
the user-facing entry point, and `recordAgentRunUsage` already meters the job
path).

**Consequences.** Every AI entry point now refuses an org that is over either AI
cap; a crawl is refused when the page budget is spent. A single model call or
crawl can still overshoot its cap by one unit before the counter catches up —
documented in `BILLING.md` §9. New `usage.enforceAiBudget` / `checkAiBudget`
exports; no new env, no migration. The full lifecycle + over-limit matrix is
pinned by `billing/lifecycle.test.ts`, `billing/expiration.test.ts`,
`usage/enforcement.test.ts`, `usage/ai-budget.test.ts` and the extended
`billing/webhook.test.ts`. See `docs/BILLING-PRODUCTION-AUDIT.md`.

## ADR-0037 — Production AI configuration (Phase 22): resilience decorator + provider-chain over the registry; env role map; per-user AI throttle; mandatory untrusted fencing

**Context.** The AI layer (`packages/ai` + the analyst modules) was built across
phases 3–20 and never audited for production. `docs/AI-ARCHITECTURE.md`
described a timeout, a provider kill switch, a role→model map and full
prompt-injection fencing as shipped — none existed. `signal?: AbortSignal` was
plumbed but unused; a hung provider hung the turn; a provider error failed the
call with no failover; retries were the SDK's invisible default; cost control
was per-org only; only the content and SEO agents fenced untrusted text.

**Decision.**

1. **Resilience is a decorator, not per-call-site.** `withResilience(provider)`
   (`packages/ai/src/resilient.ts`) adds a per-call `AbortController` deadline
   (`AI_REQUEST_TIMEOUT_MS`, 60 s), one timeout retry, and a per-call kill
   switch (`AI_DISABLED`, `AI_DISABLED_PROVIDERS` → `AiDisabledError`).
   `createRegistryFromEnv` wraps every provider, so all ~15 call sites
   (`registry.get().provider.generateObject(...)`) gain it unchanged.
2. **Fallback is a provider, composed by the registry.** `FallbackProvider`
   (`fallback.ts`) holds an ordered `{provider, model}[]`; `registry.get()` /
   `getForRole()` returns head + every configured `AI_FALLBACK_MODELS` entry
   whose provider has a key. A thrown error advances the chain;
   `AiAllProvidersFailedError` on total failure; a whole-layer `AiDisabledError`
   is surfaced. `streamText` falls back on the initial connection only.
3. **Retry split, not stacked.** Transient 429/5xx/network retry stays in the
   provider SDK, configured once from `AI_MAX_RETRIES`; the wrapper owns only
   timeout + fallback + kill switch, so the layers never compound.
4. **Role map from env.** `modelForRole('analyst'|'router'|'long_context'|
'embedding')` (`roles.ts`) reads `AI_MODEL_<ROLE>` (`"provider:model"`) with
   a per-role default; unset = identical to `AI_DEFAULT_*`. The analyst jobs
   resolve `analyst`.
5. **Per-user AI limit is a rate limit, not a billing meter.**
   `usage.enforceAiUserLimit` uses the fail-open Redis limiter
   (`AI_USER_RATE_LIMIT` / window) in front of the per-org `AI_REQUESTS`
   entitlement. Rationale: a Redis outage must never block a paying user; the
   hard monthly cap already lives in `enforceUsage`.
6. **Untrusted fencing is mandatory on every model prompt.** `wrapUntrusted` +
   `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` extended from content/SEO to the YouTube,
   TikTok and monetization analysts, the content generator, and the Growth
   Agent planner / orchestrator / memory extractor. The grounding check remains
   the post-model second line.

**Alternatives considered.** Per-call-site timeout/retry (rejected — 15+ sites,
drifts). A new `generateWithFallback` method on `AIProvider` (rejected — changes
every call site; the decorator + composed provider keep the interface). A hard
per-user billing meter (rejected — needs a new `UsageMeter` enum + counter
migration and would block users on a Redis blip; a throttle is the right tool).
Relying only on the grounding check for injection (rejected — it catches
fabricated numbers and guarantees, not "ignore your instructions / change tool
scope"; fencing closes that class).

**Consequences.** Every model call now has a deadline and, when configured, a
cross-provider fallback and a kill switch an operator can flip without a
redeploy. New optional env: `AI_REQUEST_TIMEOUT_MS`, `AI_MAX_RETRIES`,
`AI_FALLBACK_MODELS`, `AI_DISABLED`, `AI_DISABLED_PROVIDERS`,
`AI_MODEL_{ROUTER,ANALYST,LONG_CONTEXT,EMBEDDING}`, `AI_USER_RATE_LIMIT`,
`AI_USER_RATE_WINDOW_SEC` (all in `config/env.ts` + `.env.example`). Real
cross-provider failover and the live timeout path are proven only by a manual
smoke — the local suites use fakes + injected errors. `streamText` mid-stream
provider failure still degrades to the deterministic reply, not another
provider. See `docs/AI-PRODUCTION-AUDIT.md`.

## ADR-0036 — Google Search Console integration (Phase 20): reuse the Google client + callback; snapshot storage; deterministic labelled agent correlation

**Context.** `IntegrationProvider.GOOGLE_SEARCH_CONSOLE` existed as an enum value
with no code (FORENSIC-AUDIT M-5 / INT-3). Phase 20 builds the real integration
against Google's Search Console API v1. Three design choices were non-obvious.

**Decisions.**

1. **Reuse the existing Google OAuth client and the `/api/integrations/google/callback`
   route.** GSC and YouTube are both "Google", need the same client id/secret and
   the same `ENCRYPTION_KEY` token envelope, and the redirect URI is already
   registered. The callback now `verifyState`s the signed `state` and branches on
   `state.provider` (`youtube` | `google_search_console`) — the YouTube branch is
   byte-for-byte unchanged; only a post-verify branch was added. Alternative
   (a second `/api/integrations/gsc/callback` + a second registered URI) was
   rejected as needless operator setup. GSC requests `webmasters.readonly` +
   `openid` + `userinfo.email`; the connection is keyed on the account's stable
   OpenID `sub`, not on a property list (which changes).

2. **Store point-in-time snapshots, not a live pass-through or a growing
   time-series.** `SearchConsoleSite` is the durable selection/verification
   record; `SearchConsoleSnapshot` rows capture the API's output
   (`PERFORMANCE` / `SITEMAPS` / `URL_INSPECTION`). The dashboard and the SEO
   agent read the **latest** snapshot, so a GSC figure is always Google's own
   reported number for a stated window — never synthesised, and stable across a
   render. A "Refresh data" button (rate-limited) and a `search-console-sync`
   worker queue produce new snapshots. This matches the codebase's "runs inline
   now, ready for the queue" pattern (ADR-0013) and keeps the migration to two
   additive models.

3. **The crawler×GSC correlation is deterministic and source-labelled; the model
   only refines prose.** `searchconsole/correlate.ts` computes the three
   relationships the brief names (issue on an impression page; impressions but
   low CTR; sitemap page with weak internal links) as pure joins over the crawl
   pages/issues and the GSC `byPage` rows. Each result carries three explicit
   fields — `crawlerEvidence`, `searchConsoleEvidence`, `interpretation`. The
   agent's optional `searchConsoleNote` must label every sentence and is
   grounding-checked against a fact sheet that includes `gsc_*` ids; it is
   dropped on a grounding failure, leaving the deterministic block intact. No GSC
   metric is ever invented and no ranking outcome is predicted.

**Consequences.** New migration `20260918120000_search_console` (3 enums, 2
models, additive, 0 `DROP`). `webmasters.readonly` is not a Google "sensitive"
scope, so no extra Google verification/audit is required beyond publishing the
consent screen — the integration is externally-configuration-gated, not
externally-approval-gated. URL Inspection is quota-scarce (~2000/day/property),
so it is on-demand only and per-org rate-limited; Google exposes no bulk
index-coverage export, which the "Indexing" tab states explicitly.

---

## ADR-0035 — Production gap remediation (Phase 19): Resend transport, boot env validation, notifications, account/org lifecycle; RLS deferred

**Context.** The operator's "Phase 19" remediates every BLOCKER / CRITICAL /
HIGH finding in `docs/FORENSIC-AUDIT.md`, with an explicit rule against fake
implementations. Several fixes needed a decision recorded.

**Decisions.**

1. **Magic-link email → a real Resend HTTP transport.** `EMAIL_TRANSPORT` now
   takes `resend | smtp | console`. `resend` POSTs to `https://api.resend.com/emails`
   with `fetch` (no SDK, no new dependency) and makes passwordless sign-in work
   with **one API key and no SMTP infrastructure**. A production config with no
   real delivery path **and** no Google OAuth is rejected by `check-env.mjs`
   and by the boot validator — a deploy can no longer ship with no way to sign
   in. `RESEND_API_KEY` moves from a dead `.env.example` var to an implemented one.

2. **Boot-time env validation lives in `packages/services/src/config/env.ts`**
   (shared by web + worker), imported for its side effect from
   `apps/web/app/layout.tsx` and `apps/worker/src/main.ts`. It is Zod-typed
   always and **prod-strict** (required core set, `AUTH_URL == NEXT_PUBLIC_APP_URL`
   https, `AUTH_DEV_LOGIN != true`, a sign-in path) when `NODE_ENV=production`
   and it is not `next build` / vitest. The dead `apps/web/src/env.ts` is
   deleted; `scripts/check-env.mjs` remains the pre-deploy gate.

3. **Notifications: a real in-app system, email fan-out best-effort.** New
   `Notification` model + `notifications` service modelled on `recordAudit`
   (never throws, dedupe-keyed). Wired to the completion points that already
   exist (report ready/failed, crawl finished/blocked, automation
   FAILING/DISABLED, invitation created). Email is sent only when a transport is
   configured; **weekly digests are explicitly not implemented** and marked
   externally-dependent. `userId = null` rows are org-wide with a single shared
   `readAt` (acceptable for broadcast notices); targeted rows are per-user.

4. **Account/organization deletion: soft-delete → grace → worker purge.** A
   request sets `deletionScheduledAt = now + grace` (default 7 days,
   `ACCOUNT_DELETION_GRACE_DAYS`); an hourly `lifecycle-sweep` on the existing
   `automation` queue hard-deletes due organizations (cascading via the FKs —
   `crawl_pages` / `crawl_links` `onDelete` changed `RESTRICT → CASCADE` in
   migration `20260917120000`) and anonymises due users (email → tombstone,
   name/image nulled, memberships/accounts/sessions removed, row kept). A
   user-deletion request bumps `sessionVersion` (immediate sign-out) but does
   **not** set `deletedAt` — the user can sign back in during grace to cancel;
   organizations where they are the sole owner are scheduled for deletion too.
   A JSON DSR export route composes the existing per-module reads (encrypted
   OAuth tokens excluded).

5. **Postgres RLS (M-9 / S-1) is deferred to its own phase.** The approved
   "scoped RLS via `withOrgScope`" is not viable as specified: `withOrgScope`
   exists in `packages/db` but is **called nowhere** — services do ~321 direct
   `prisma.<tenantModel>` calls across 28 files. Enabling `FORCE ROW LEVEL
SECURITY` without first retrofitting a `withTenant()` GUC wrapper to all of
   them would make nearly every tenant read return zero rows, and that retrofit
   cannot be verified without a live Postgres (unavailable this session).
   Instead: (a) `scripts/check-tenant-scope.mjs` fails CI on a list/bulk/aggregate
   query on a tenant table in `packages/services` that has no nearby
   `organizationId` (opt-out: `// tenant-scope-ok:`); (b) the tenant-isolation
   integration suite stays the enforced backstop; (c) RLS is tracked as a HIGH
   needing a dedicated phase (it also wants a second, non-owner DB role).

6. **CI now enforces what it used to only lint.** A `docker` job builds both
   images for real and boots `docker-compose.production.yml` against throwaway
   Postgres/Redis, asserting `/api/health` and the worker `/healthz`. The
   `verify` job runs the `NEXT_OUTPUT_STANDALONE=1` build. `scripts/audit-allow.mjs`
   - `.audit-allowlist.json` fail CI on any **new** moderate+/high advisory
     while carrying the currently-unavoidable `nodemailer` / `deepmerge-ts` / `ai`
     ones with a reason and a review-by date.

**Alternatives considered.** Full `withTenant` RLS retrofit now — rejected
(unverifiable without a DB, high blast radius, exactly the "unnecessary
refactor" earlier phases forbade). Bumping `nodemailer` to ≥9.1 — still blocked
by the `@auth/core@0.41.3` peer `^7 || ^8`; the Resend transport sidesteps it
for real deployments. A dedicated `lifecycle` BullMQ queue — folded into the
existing `automation` sweep to avoid a new cross-package queue producer.
Impersonation-safe per-user read state for org-wide notifications (a join
table) — deferred; broadcast notices with a shared `readAt` are adequate.

**Consequences.** New migration `20260917120000_notifications_lifecycle` (one
enum, one table, three nullable columns, two FK redefinitions — no
`DROP TABLE`/`DROP COLUMN`). New env: `RESEND_API_KEY` (implemented),
`ACCOUNT_DELETION_GRACE_DAYS` (optional). New CI jobs/steps. RLS remains the top
open HIGH; `docs/FORENSIC-AUDIT.md` §11 carries the per-item status.

---

## ADR-0034 — Forensic codebase audit: four documented subsystems have no implementation; deploy path unproven

**Context.** A second, evidence-only pass over the whole repository (the
operator's "Phase 18 — Forensic Codebase Audit"), explicitly instructed not to
trust prior audit claims and to classify every module from the source alone.
Recorded in `docs/FORENSIC-AUDIT.md`.

**Findings that change the project's understanding of itself.**

1. **Object storage, Sentry, OpenTelemetry, and Resend/Upstash are MISSING, not
   partial.** `.env.example`, `CLAUDE.md` ("Stack"), `ARCHITECTURE.md` and
   `docs/DEPLOYMENT.md` present all four as part of the system. Grep across
   `apps/` + `packages/` (non-test) returns **zero** implementing code: no
   `@aws-sdk`/`minio`, no `@sentry/*`, no `@opentelemetry/*`, no `resend`, no
   read of `S3_*` / `SENTRY_DSN` / `OTEL_*` / `UPSTASH_*` / `RESEND_API_KEY`.
   The notification system and Google Search Console are likewise enum/doc-only.
2. **`apps/web/src/env.ts` is dead code.** Nothing imports it, so there is **no
   boot-time environment validation** despite the `Dockerfile.web` comment
   saying "the app also self-validates env at boot". The only gate is the manual
   `scripts/check-env.mjs`.
3. **The container images have never been built.** CI runs only
   `docker buildx build --call=check` (a linter) with `continue-on-error: true`,
   and never exercises the `NEXT_OUTPUT_STANDALONE=1` build that `Dockerfile.web`
   depends on.
4. **Magic-link sign-in is inert by default** (`EMAIL_TRANSPORT=console`), and
   Postgres RLS — documented as the tenant-isolation backstop — is not
   implemented in any migration.

**Decision.** No code changed (audit-only brief). `docs/FORENSIC-AUDIT.md` is
the authoritative gap report; its §10 remediation order supersedes the softer
framing in `docs/FINAL-AUDIT.md` and `docs/PRODUCTION-READINESS.md` where they
disagree. The "four MISSING subsystems" are to be corrected in the docs (marked
_planned_, not _stack_) as the first non-blocking cleanup — tracked, not done
here.

**Consequences.** Production readiness now has four hard prerequisites beyond the
earlier lists: a proven `docker build` + standalone build in CI, env validation
wired into the container start, working email (or a documented Google-only
sign-in), and honest capability docs. Account/organization deletion + DSR
remains the compliance blocker for an EU/California GA.

---

## ADR-0033 — Complete application audit (Phase 18): audit-only; not "production-ready" for GA; beta-ready

**Context.** The operator's "Phase 18" is an independent full-application audit
(CTO / QA / security / DevOps / product) with an explicit brief: **do not add
features, do not redesign, do not refactor unnecessarily**, run the entire
pipeline, classify every finding BLOCKER / CRITICAL / HIGH / MEDIUM / LOW / PASS,
fix errors that are discovered, and **only call the app production-ready if the
evidence supports it**. The full pipeline was re-run: format, lint (14/14),
typecheck (14/14), unit (515/515), env-script tests (9/9), integration (CI
Postgres), Playwright e2e (58 passed / 5 infra-skipped), web + worker builds
(exit 0), `prisma validate`, `pnpm audit --prod`.

**Decision.** The audit is recorded in `docs/FINAL-AUDIT.md`. Key calls:

1. **No code changes beyond doc corrections.** The pipeline is green and no
   BLOCKER or CRITICAL defect exists, so — honouring the "no refactor" brief —
   nothing was changed except correcting docs that over-claimed. The
   previously-agreed deferrals hold: **do not** add `onDelete: Cascade` to
   `CrawlPage`/`CrawlLink` yet (no trigger exists — no org-delete code — and the
   fix needs a constraint-redefinition migration; it becomes a prerequisite of
   the org-delete flow, tracked as DB-3), **do not** wire Sentry (a feature —
   the docs were corrected instead, OBS-2), **do not** prune unused deps
   (lockfile-churn risk this late — documented as L-4), **do not** refactor the
   `youtube`/`tiktok` lib duplication (L-5).
2. **The application is NOT declared production-ready for general availability.**
   The evidence supports "well-engineered, thoroughly tested, no
   BLOCKER/CRITICAL" and "defensible for a closed / invite-only beta once email
   sign-in and the container build work" — it does **not** support a GA claim.
   GA is gated on: a live-deployed + smoke-tested stack (Docker + Next
   standalone builds have never run on a real builder), deployed
   monitoring/alerting, the `nodemailer` HIGH advisories resolved or formally
   accepted, account-deletion / DSR flows for EU/CA (COMP-1), and an external
   penetration test (SEC-5).
3. **Docs corrected to stop over-claiming.** Object storage (INT-2), Sentry
   (OBS-2), Google Search Console (INT-3), and the notification system
   (FEAT-24) are referenced in env/enum/docs but **not implemented**; the audit
   records each as such and the surrounding docs were softened to "planned".
   End-to-end magic-link sign-in **does not function** without an SMTP/Resend
   provider (FEAT-1) — called out as a deployment prerequisite, not a code bug.

**Alternatives considered.** Fixing DB-3 now — rejected: a non-additive
constraint migration with no failure it currently prevents; correct to bundle it
with the org-delete work. Implementing notifications / object storage / GSC to
match the docs — rejected: squarely "new features", out of scope for an audit.
Calling the build-green state "production-ready" — rejected: the operator
explicitly forbade it and the evidence does not support it.

**Consequences.** `docs/FINAL-AUDIT.md` is the launch-gating document alongside
`docs/PRODUCTION-READINESS.md`. The HIGH ledger (SEC-1 `nodemailer`, FEAT-1
email sign-in, COMP-1 deletion/DSR) plus "verify the container build" are the
critical path to GA. No further phase starts without an explicit instruction.

---

## ADR-0032 — Launch review (Phase 17): no blockers; keep `nodemailer` on v8 for now; harden the public report export

**Context.** The operator's "Phase 17" is an independent CTO-style launch
review of the whole repository — code, architecture, security, testing,
deployment, docs — classifying findings BLOCKER / CRITICAL / HIGH / MEDIUM / LOW
and fixing the first two. The full pipeline was run
(`docs/PRODUCTION-READINESS.md`). No BLOCKER or CRITICAL was found. Two decisions
had to be recorded.

**Decision.**

1. **`nodemailer` stays on `^8.0.9` at launch (finding H-2).** `pnpm audit`
   flags six advisories (3 high) fixed only in `nodemailer >= 9.1.1`, but
   `next-auth@5.0.0-beta.32` / `@auth/core@0.41.3` declare a **hard peer**
   `nodemailer@"^7 || ^8"` and their Nodemailer provider is written against the
   v8 API — installing v9 produces an unmet-peer state. Bumping the NextAuth
   beta pre-launch is the larger risk (a beta bump already regressed
   `callbackUrl` — ADR-0028). The residual exposure is limited: the app never
   passes the `raw` option, `to` is a single `EMAIL_RE`-validated address, `from`
   is a fixed constant, and the app does not use nodemailer's recipient-domain
   allow-listing; the O(n²) parse needs an address our validation rejects. The
   launch checklist carries: bump the moment the peer is relaxed, plus SPF/DKIM/
   DMARC and a provider-side send-rate cap. The app-level magic-link limiter
   (5/hour/email) already caps volume.
2. **The public report export is rate-limited + cacheable (finding H-1, fixed).**
   `GET /r/[token]/export` is unauthenticated and re-renders a PDF per request
   with `no-store` — a CPU-amplification DoS for anyone holding a shared token.
   It now takes a per-IP `security.checkRateLimit` (30/min) and returns
   `Cache-Control: private, max-age=60` (safe — a `ReportSnapshot` is immutable
   once `READY`; short so a revoke still bites). The authenticated
   `/app/reports/[id]/export` gets a matching per-org+user limit (60/min).
   `/admin` also gained a `loading.tsx` skeleton (M-1).

**Alternatives considered.** Forcing `nodemailer@9` via `pnpm.overrides` —
rejected: overrides cannot satisfy a peer _range_, and the provider code would
still be v8-shaped at runtime (untestable here without a mail server). Forcing
`deepmerge-ts>=8` via override (M-3) — rejected: it is a Prisma-CLI build-time
transitive with no attacker input; overriding it risks the Prisma toolchain.
Migrating the `ai` SDK to v5 (M-3) — rejected for this phase: a breaking major
across every agent, its own phase; the flagged file-upload feature is unused.

**Consequences.** Launch is gated on the checklist in
`docs/PRODUCTION-READINESS.md` §8 (chiefly: run the Docker + standalone builds
on a real builder, verify migration drift, set up mail-domain auth). No feature
code changed beyond the two small hardening edits.

---

## ADR-0031 — Production deployment: two containers, worker runs from TS via `tsx`, migrations as a release step, single-host compose + Caddy as the reference

**Context.** The operator's "Phase 16" is deployment _preparation_ — Dockerfiles,
a production compose, deployment config, env documentation, migration + backup
strategy, health/logging/monitoring config, a 17-step `DEPLOYMENT.md`, and an
env-validation script that never prints secret values. Two things needed a
decision: (a) the monorepo consumes `packages/*` as **TypeScript source**
(`"main": "./src/index.ts"`), so `apps/worker`'s `tsc` build produces a
`dist/main.js` that `import`s `.ts` files Node cannot run — the worker was not
actually production-runnable; (b) the hosting platform is still an open decision
(OD-1), so the deliverables must not hard-commit to one.

**Decision.**

1. **Two independent images.** `Dockerfile.web` — Next.js **standalone** output
   (`node apps/web/server.js`); `Dockerfile.worker` — Node + Playwright
   Chromium. Multi-stage, non-root, `HEALTHCHECK` on `/api/health` and
   `/healthz`. `next.config.mjs` gains `outputFileTracingRoot` (monorepo root)
   and force-includes the Prisma query engine so standalone tracing is complete.
2. **The worker runs from TypeScript source via `tsx`** — the same mechanism as
   `pnpm dev` — rather than a compiled/bundled dist. `tsx` moves to the worker's
   `dependencies`; `start` becomes `tsx src/main.ts`; the image ships the whole
   workspace + resolved `node_modules`. Rejected alternatives: an esbuild bundle
   (fragile with Prisma's generated client + engine and Playwright's runtime
   file loads) and compiling every workspace package to JS (large `tsconfig`
   surgery for no runtime benefit).
3. **Migrations are a discrete release step, never at container boot.**
   `prisma migrate deploy` against `DIRECT_URL`, after a fresh backup, in the
   order backup → migrate → web → worker. Migrations stay checked-in,
   forward-only and expand/contract so a code rollback needs no schema
   rollback.
4. **`docker-compose.production.yml` + Caddy is the reference single-host
   deploy, not the only one.** It runs `web` + `worker` + Caddy (auto-TLS,
   canonical-host redirect, `immutable` cache headers) + a one-shot `migrate`
   service, and expects **external managed** Postgres / Redis / object storage
   via `.env.production`. On Fly/Render/ECS/k8s the two Dockerfiles are used
   directly. `deploy/` holds `Caddyfile`, `prometheus.yml`, `alerts.yml` and
   the `backup/` scripts.
5. **Backups: provider PITR _plus_ a portable second copy.**
   `deploy/backup/pg-backup.sh` does `pg_dump -Fc` → optional gpg → object
   storage with retention pruning; `pg-restore.sh` restores into a **scratch**
   DB (test quarterly).
6. **`scripts/check-env.mjs`** — zero-dependency Node. Classifies every variable
   by target (web/worker) and feature group (all-or-nothing: Google pair,
   TikTok pair, Stripe set, S3 set), validates shape with **rule-only reason
   strings**, and reports each var as `set` / `MISSING` / `invalid` — **it never
   echoes a value**. Exit 1 on any blocking problem; `--json` for machines;
   `--file` to check an env file; `--allow-insecure` for staging. Contract is
   pinned by `scripts/check-env.test.mjs` (run via `pnpm test:scripts`),
   including an explicit "NEVER prints a secret value" assertion.

**Consequences.** The worker image carries `tsx` + the full workspace (larger
than a bundle, simpler and correct). Standalone `web` cannot be built on Windows
(`EPERM` on symlinks) — CI/Docker only; documented. Hosting stays undecided
(OD-1) — the compose file is a working default, not a commitment. New env:
`APP_DOMAIN`, `TLS_EMAIL`, `BACKUP_*` (deploy-only). New root scripts:
`pnpm check:env`, `pnpm test:scripts`.

---

## ADR-0030 — Full-QA pass: integration tests run in CI only; authenticated e2e mints a session cookie

**Context.** The operator's "Phase 15" is a production-level QA pass — add unit,
integration, API, database, security and e2e tests across every feature and a
long list of failure scenarios, run the suites, and fix (not suppress) failures.
Two structural questions had to be settled: (a) this environment has **no local
Docker** — no Postgres, no Redis — so anything DB- or Redis-backed cannot run
here; (b) there is **no way to log a browser in** for authenticated e2e — the
magic-link needs a mail transport and the dev-credentials provider is
`NODE_ENV !== 'production'`-gated (Phase 14 hardening), while the e2e server runs
a production build.

**Decision.**

1. **Integration tests are CI-authoritative and self-skip locally.** Every
   `*.integration.test.ts` runs `SELECT 1` in `beforeAll` and downgrades its
   `it` to `it.skip` when the DB is unreachable (the existing convention). Three
   new suites use it: `security/tenant-isolation.integration.test.ts`,
   `automation/idempotency.integration.test.ts`,
   `billing/webhook.integration.test.ts`. CI already provisions Postgres + runs
   `migrate:deploy` for the integration and e2e jobs.
2. **API-contract tests live in the e2e suite**, driven by Playwright's
   `request` fixture against `next start`. They assert auth gating, status
   codes, error shape, hardening headers and rate-limit behaviour — all of
   which resolve before any DB work, so no database is needed. This is cheaper
   and more faithful than mocking `server-only` / `next/headers` to unit-test
   route handlers.
3. **Authenticated e2e mints the NextAuth JWE session cookie directly.**
   `e2e/authed.spec.ts` seeds a user + org via Prisma and calls
   `encode()` from `next-auth/jwt` with the same `AUTH_SECRET` the Playwright
   `webServer` uses (both fall back to one constant), then `addCookies`. No
   test-only sign-in route is added (that would be new attack surface). The spec
   is gated on `E2E_AUTHED=1` **and** DB reachability; the CI `e2e` job sets the
   flag, a plain `pnpm test:e2e` skips it.

**Alternatives considered.** A test-only `/api/test/login` route — rejected:
permanent attack surface for a test convenience. Running the e2e server in
`next dev` so dev-credentials work — rejected: `next dev` is materially flakier
and slower, and it would diverge the e2e target from production. A second
Playwright config + a DB seed job — rejected as more moving parts than a
one-line `E2E_AUTHED` env plus a self-seeding spec. Spinning up Postgres/Redis
locally — not possible in this environment.

**Consequences.** Local `pnpm test` + `pnpm test:e2e` cover unit + public/API
surface; the DB-backed guarantees (tenant isolation, webhook/automation
idempotency under concurrency, authenticated flows) are proven in CI. Redis is
still not in CI, so the rate limiter's runtime effect rests on its unit tests +
fail-open path; the e2e health-burst test only asserts "never 5xx". `docs/QA.md`
is the living coverage map and calls out these residuals.

---

## ADR-0029 — Security-hardening pass: session-bound OAuth callbacks, a fail-open Redis rate limiter, a CSP, and an untrusted-content fence

**Context.** The operator's "Phase 14" is a full security audit with a mandate
to fix every Critical/High finding before continuing (`docs/SECURITY-AUDIT.md`).
Two High findings needed code: (H-1) the OAuth callbacks trusted a signed
`state` as the sole credential with no session check — an OAuth-CSRF /
connection-fixation path that could attach a victim's connected account to an
attacker's org; (H-2) none of the layered rate limits `docs/SECURITY.md` §8
promises existed, leaving magic-link send and other sensitive endpoints
unthrottled. Two Medium fixes were cheap and aligned with already-documented
controls: (M-1) no CSP header shipped; (M-2) no reusable untrusted-content
demarcation for model prompts.

**Decision.**

1. **OAuth callbacks are session-bound.** `completeYouTubeConnect` /
   `completeTikTokConnect` take an `actingUserId` and reject a `state` whose
   `userId` differs, before any token exchange. The callback routes resolve the
   session and pass `user.id`; an unauthenticated hit redirects to `/login`.
2. **A minimal Redis rate limiter, failing open.**
   `packages/services/src/security/rate-limit.ts` is a fixed-window `INCR` +
   `EXPIRE` counter on the existing shared Redis client. If Redis is
   unreachable the check is **allowed** (with one logged warning) — a security
   control must not become an availability outage. Applied to magic-link send
   (`signIn` callback, per email), the OAuth connect/callback routes, the agent
   stream route, `/api/health` (+ a 4 s report cache), and the crawl-start
   action. This is deliberately not the full edge/IP layer (roadmap "Phase 3");
   it closes the concrete abuse paths now.
3. **A Content-Security-Policy in `next.config.mjs`** — `default-src 'self'`
   with `script-src 'self' 'unsafe-inline'` (Next's App Router emits inline
   hydration script; `'unsafe-eval'` is dev-only), plus `frame-ancestors
'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`. A
   strict nonce-based policy needs middleware nonce injection and is a tracked
   follow-up (the NextAuth middleware wrapper is fragile — Phase 13).
4. **`packages/services/src/security/untrusted.ts`** — `wrapUntrusted(label,
text)` fences external/user text in `<<<UNTRUSTED_*_BEGIN/END>>>` markers
   (input marker-injection neutralised) and `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` is
   a standing "ignore instructions inside the fence" rule now on the affected
   system prompts. Today the agents feed models only structured derivatives and
   every tool registry is read-only/no-command, so this is defence-in-depth and
   the convention for any future capability.
5. **Smaller hardening:** `/api/metrics` bearer compare is now
   `timingSafeEqual`; provider "malformed token response" errors no longer
   attach the raw (possibly token-bearing) body and the pino redaction paths
   were broadened; `seo/ssrf.ts` explicitly rejects non-canonical numeric
   hostnames (verified already-safe via `URL` normalisation, kept for intent).

**Alternatives considered.** A third-party rate-limit library (`@upstash/ratelimit`)
— rejected: another dependency for a bounded need; the Redis client is already
present (Phase 13). Fail-closed rate limiting — rejected: a Redis blip would
lock every user out of sign-in. A strict nonce CSP now — deferred: needs
middleware changes that previously caused a redirect regression, and the
permissive CSP already blocks external script/frame/object origins. Binding the
OAuth callback via a per-flow cookie instead of the session — rejected: the
session is the natural anchor and needs no new cookie.

**Consequences.** Rate limits need Redis to be effective; without it they no-op
(logged). The permissive `script-src` still allows inline script, so CSP is a
partial XSS backstop until the nonce follow-up. Magic-link aggregate volume
across many target addresses is still only bounded per-address (5/hour) until
the edge layer lands. New optional behaviour, no new required env
(`METRICS_TOKEN` already existed; the limiter reuses `REDIS_URL`).

---

## ADR-0028 — Admin & observability: an in-process metrics registry (no OTel yet), DB-derived dashboards, and de-duplicated error rows

**Context.** The operator's "Phase 13" needs an internal `/admin` system
(users, orgs, subscriptions, usage, AI usage, agent runs, crawler jobs, API
integrations, errors, audit logs, system health, background jobs), the ten
named operational metrics (request latency, error rate, API failures, AI
latency / tokens / cost, crawler failures, queue depth, job duration, database
performance), structured logs with correlation ids, and health checks for the
database, Redis, the AI provider and external integrations — **without
exposing secrets**. `ARCHITECTURE.md` §9 has long named OpenTelemetry + a
Prometheus `/metrics` endpoint as the target, but the observability package
shipped with only a pino factory ("OTel/metrics later").

**Decision.**

1. **A hand-rolled in-process metrics registry**, not the OpenTelemetry SDK.
   `packages/services/src/observability/metrics.ts` holds counters, gauges and
   fixed-bucket histograms in memory and renders Prometheus text at
   `GET /api/metrics` (web) and `:$WORKER_HEALTH_PORT/metrics` (worker). No new
   dependency, consistent with the Stripe-adapter / PDF-writer / cron
   precedents (ADR-0025/0026/0027). A real OTel SDK + collector remains a
   future ADR; the registry's Prometheus output is already scrape-compatible.
2. **Two metric sources.** The registry is **per-instance and resets on
   deploy** — fine for a live scrape, useless for a dashboard rendered in one
   web process. So the durable numbers on `/admin` are **computed from the
   database**: AI usage / cost / latency from `AgentRun`, crawler stats from
   `Crawl`, job duration from `AutomationRun`, and PostgreSQL health from
   `pg_stat_*`. `/admin/system-health` shows both, and labels the registry
   figures "this instance".
3. **Errors are de-duplicated at write time.** `captureError` computes a
   `fingerprint` (source + error name + first own stack frame + route) and
   upserts one `ErrorEvent` row with a bumped `count` / `lastSeenAt`. A storm
   of one bug is one row, not a flooded table. Wired into Next's
   `onRequestError` instrumentation hook, `withRouteObservability`, and the
   worker's `instrumentJob`.
4. **Secrets are kept out by four independent layers** — pino key-path
   redaction, `scrubSecrets` on persisted/displayed free text, explicit Prisma
   `select`s that never touch the token-cipher columns, and Stripe-id masking.
   `/api/metrics` is gated by `Bearer $METRICS_TOKEN` or a platform-staff
   session.
5. **Correlation ids in the observability layer, not middleware.** A
   `x-correlation-id` from a trusted proxy is honoured, otherwise one is minted
   — in `withRouteObservability` (route handlers) and the `cache()`d
   `getCorrelationId()` (server components) — and threaded into jobs via
   `job.data.correlationId`. It is deliberately **not** set in `middleware.ts`:
   wrapping NextAuth's `auth()` with a handler in `next-auth@5.0.0-beta.32`
   drops the `?callbackUrl=` from the unauthenticated redirect, so the
   middleware stays the bare `export default auth`.
6. **Two new non-tenant tables** — `ErrorEvent`, `WorkerHeartbeat` — with no
   `organizationId` FK (like `BillingEvent`) so they outlive the org they
   mention. Migration `20260916120000_admin_observability`, additive.
7. **`bullmq` + `ioredis` added to `packages/services`** for the admin queue
   views and the Redis health ping. Their Node built-ins are kept out of the
   edge bundle by never importing `observability/queues` or `observability/redis`
   from `middleware.ts`, and by nesting the `instrumentation.ts` `import()`
   inside a `NEXT_RUNTIME === 'nodejs'` check.

**Alternatives considered.** Full OpenTelemetry SDK + OTLP collector now —
rejected for this phase: a large operational surface (collector deployment,
sampling config, exporter creds) for a single-node deployment; the registry
covers the named metrics and the migration path is open. A `RequestMetric` /
`HttpMetricBucket` table written by a rollup — rejected: high write volume for
data a Prometheus scrape already handles; DB aggregates cover the durable view.
One `ErrorEvent` row per occurrence — rejected: unbounded growth under a fault
storm. A dedicated admin micro-app — rejected: `apps/web` already has the auth,
RBAC and UI kit; a route group is enough.

**Consequences.** Registry metrics are lost on restart and are per-instance —
operators must run a scraper for history and fleet-wide totals (documented in
`OBSERVABILITY.md` §9 and `DEPLOYMENT.md`). `/admin` is read-only. The AI
"cost" figure is an internal estimate from `packages/ai`'s price table, never a
billed amount. `pg_stat_statements` is optional; its panel is empty without the
extension. New optional env: `METRICS_TOKEN`, `WORKER_HEALTH_PORT`.

---

## ADR-0027 — Automation engine: DB-defined rules, a worker "sweep" for scheduling, a hand-rolled cron, owner-permission re-check at run time, and no external publishing

**Context.** The operator's "Phase 12" needs scheduled automations
("Analyze my YouTube channel every Monday", "Crawl my website every week",
"Send me my weekly growth report", "Tell me when a critical SEO issue appears",
"Find my biggest content opportunity every Friday"). Each automation must carry
id, organization, owner, task type, schedule, configuration, last run, next run,
status and failure count, with retry + exponential backoff + idempotency +
cancellation + execution logs. **An automation must never exceed the user's
permissions**, and **external publishing actions require explicit
authorization**.

**Decision.**

1. **Rules live in the database, not in BullMQ repeatable jobs.**
   `AutomationRule` holds the schedule (`cronExpression` derived from a
   `cadence` of DAILY / WEEKLY / MONTHLY, or a raw expression for CUSTOM) plus
   `status`, `nextRunAt`, `failureCount`, `totalRuns`, `maxRetries`. A single
   BullMQ **repeatable "sweep"** (every 60s) finds rules whose `nextRunAt` has
   passed and processes them; a second repeatable **retry-sweep** (every 30s)
   picks up runs due for a backoff retry. This keeps per-user schedules, audit,
   RBAC and history in one queryable place and avoids a per-rule repeatable job
   that would drift from the row.
2. **A tiny hand-rolled cron.** `automation/cron.ts` parses the 5-field syntax
   (`*`, `a`, `a-b`, `a,b`, `*/n`, `a-b/n`, standard dom/dow "either" rule) and
   computes the next matching minute. No dependency. **Schedules are evaluated
   in UTC** for v1; `AutomationRule.timezone` is stored for a later
   timezone-aware pass. (Documented limitation.)
3. **Idempotency via a unique run key.** Each execution is an `AutomationRun`
   with `@@unique([automationRuleId, scheduledFor])`, where `scheduledFor` is
   snapped to the rule's own `nextRunAt`. A double sweep, a worker restart
   mid-tick, or a duplicated job all resolve to "already claimed — skip".
4. **The owner's RBAC is re-checked at execution time.** Every task type maps to
   exactly one `requiredAction` (`TASK_TYPE_META`). Before dispatch the runner
   resolves the **owner's current membership + role** and calls the shared
   `authorize()` choke point. If the owner lost the role (or left the org) the
   run is marked `SKIPPED` and the rule is `PAUSED` — the automation cannot do
   something its owner currently cannot. Configuring a rule checks the same
   thing up front.
5. **No task type publishes externally.** The seven task types are all
   read/analysis/report actions (`agent:run`, `crawl:run`,
   `monetization:manage`, `report:generate`). `TASK_TYPE_META` carries
   `externalPublish: false` for all of them and `assertNoExternalPublish()` is a
   unit-tested invariant. TikTok/YouTube publishing stays behind its own
   approval flow (ADR-0017/0022) and is not reachable from an automation.
6. **Retry + backoff + escalation.** A failed execution with attempts left →
   `RETRY_SCHEDULED` with `nextAttemptAt = now + 60s·2^(attempt-1)` (capped at
   1h). After `maxRetries` the tick is `FAILED` and the rule's consecutive
   `failureCount` increments; at 5 the rule becomes `FAILING` (still scheduled,
   surfaced), at 10 `DISABLED` (the sweep skips it until the user re-enables).
   Success resets `failureCount` and lifts `FAILING`.
7. **Runs execute inline in the sweep** (bounded — one analyst / crawl / report
   call), consistent with ADR-0013; the queue is there and a per-run `execute`
   job type exists for a future hand-off. RBAC action `automation:manage`
   (MEMBER+) gates create / update / pause / resume / delete / run-now.

**Alternatives.** One BullMQ repeatable job per rule — rejected: the schedule
then lives in Redis, not the DB; changing a rule means reconciling the
repeatable; a lost Redis loses every schedule. A cron library (`cron-parser`,
`croner`) — rejected: a ~150-line parser covers the cases the UI can produce and
adds no dependency (same reasoning as the hand-rolled Stripe gateway and PDF
writer). Running the owner's permission check only at creation — rejected by
"never exceed the user's permissions": roles change. A `PUBLISH` task type
behind a confirm — rejected by "external publishing actions require explicit
authorization"; it stays in its own feature.

**Consequences.** New tables `AutomationRule`, `AutomationRun` (migration
`20260915120000_automation`, additive). New RBAC action `automation:manage`
(MEMBER+). New `automation` BullMQ queue carrying two repeatable ticks
registered by the worker on start. New `/app/automations` list + detail
(execution log). Schedules are UTC-only for now; a very slow underlying job
could make one sweep tick long (bounded by the single analyst/crawl/report
call). No notification channel yet — an alert automation opens a `Task`.

## ADR-0026 — Reporting: immutable snapshots, on-demand exports, a hand-rolled PDF writer, and redacted public share links

**Context.** The operator's "Phase 11" needs a reporting engine covering seven
types (YouTube, TikTok, SEO, Website Health, AI Recommendations, Growth,
Monetization), each with the same seven sections (Executive Summary, Key
Metrics, Problems, Opportunities, Recommendations, Priority Actions, Historical
Changes), with dashboard viewing, PDF/CSV export, shareable links "where
authorized", **no private account information through public URLs**, and
**snapshots so historical reports do not change unexpectedly**.

**Decision.**

1. **A report IS an immutable snapshot.** `generateReport` gathers deterministic
   facts from the existing module read functions, assembles the seven sections,
   builds the executive summary, and writes the whole `ReportSnapshot`
   (`packages/core` `schemas/report.ts`) once onto the `Report` row when it
   becomes `READY`. The row is never mutated after that. Regenerating creates a
   **new** `Report` that links to the previous `READY` report of the same type
   via `previousReportId`; that link drives the "Historical Changes" diff. The
   dashboard and every export render from the stored snapshot, so a shared or
   downloaded report can never drift.
2. **Exports are rendered on demand, not stored.** The snapshot is the durable
   artifact; `renderExport(snapshot, 'pdf'|'csv'|'json')` produces the file at
   request time. No object storage, no stale files, no `storageKey` (the design
   doc's `Report.storageKey`/`sizeBytes` are dropped).
3. **A hand-rolled PDF writer.** `reports/pdf/` is a ~200-line PDF generator
   using the base-14 Helvetica fonts (no embedded font file), with text
   wrapping from an embedded Helvetica width table, headings, key/value rows,
   simple tables, auto page-breaks and a footer. No PDF dependency and no
   headless-Chromium coupling (same "own the insulation layer" reasoning as the
   Stripe gateway in ADR-0025). Limitation: text-only, no charts (v1).
4. **Executive summary is deterministic-first.** An always-available
   deterministic assembly; an optional single grounded model pass
   (`checkGroundingFields` against an id-tagged fact sheet) may replace the
   prose and is **dropped** on any grounding failure. Never guarantees an
   outcome.
5. **Share links are opaque tokens serving a redacted snapshot.**
   `Report.shareToken` is 32 random bytes (base64url); `shareExpiresAt` /
   `shareRevokedAt` gate it. The public route `/r/<token>` and its export
   endpoint return `redactSnapshotForPublic(snapshot)` **only** — the subject
   label and org name become generic text, every free-text field is scrubbed of
   emails / URLs / @handles / long ids, and raw monetary amounts are hidden
   (aggregate counts, scores and relative deltas stay). An unknown / expired /
   revoked / non-`READY` token is a plain 404. Creating or revoking a link is
   gated by the new `report:share` action (ADMIN+), because it exposes data
   outside the org; generating / deleting a report is `report:generate`
   (MEMBER+); viewing + authenticated export is the existing `report:read`
   (VIEWER+).
6. **Metering.** `usage.enforceUsage({ meter: 'REPORTS' })` runs server-side
   before generation (Phase 10 left this as the wiring point); `usage.recordUsage`
   records one unit, idempotent on the report id.

**Alternatives.** Rendering PDF via the worker's headless Chromium
(`page.pdf()`) — rejected: couples every export to Redis + Chromium and a
queue round-trip for what is a bounded, synchronous transform. A PDF library
(`pdfkit`, `@react-pdf/renderer`) — rejected: a heavy dependency (fonts,
sub-deps) for a text report. Storing exported files in object storage —
rejected: the snapshot already is the immutable source; on-demand rendering
removes a staleness class and a storage dependency. Live queries when viewing a
historical report — rejected outright by "snapshots so historical reports do not
change".

**Consequences.** New table `Report` (migration `20260914120000_reporting`,
additive). New `ReportSnapshot` contract in `packages/core`. New RBAC actions
`report:generate` (MEMBER+) and `report:share` (ADMIN+). New public routes
`/r/[token]` + `/r/[token]/export`, excluded from auth middleware (only `/app`,
`/admin`, `/onboarding` are protected) and marked `noindex`. The
`report-generation` worker queue gets a real processor; a single report still
generates inline in the Server Action (ADR-0013 pattern). Deferred: charts in
the PDF, scheduled report packs, per-website report params in the UI beyond the
default pick.

## ADR-0025 — Billing implementation: a config plan catalog, a hand-rolled Stripe gateway behind an interface, an idempotency ledger, and a `usage` module split from `billing` (implements ADR-0010)

**Context.** ADR-0010 chose Stripe + metered usage. The operator's "Phase 10"
requires: configuration-based plans (FREE / CREATOR / PRO / AGENCY / ENTERPRISE),
checkout, subscriptions, upgrades / downgrades / cancellation, billing portal,
invoices, webhook processing, subscription status, usage limits + feature
entitlements, metering for AI requests, AI tokens, website crawls, crawl pages,
connected accounts, reports and content generation, **server-side** limit
enforcement, and **idempotent** webhook processing. Prices must not be
hard-coded across the app.

**Decision.**

1. **Plans are a config catalog, not a table.** `billing/plans.ts` `PLAN_CATALOG`
   is the single source of truth for each tier's display price, per-meter limits
   (`null` ⇒ unlimited) and feature flags. Stripe Price IDs are environment
   config (`billing/config.ts`), so the same catalog code runs in every
   environment. The design doc's separate `Price` table is dropped — a mirror
   table would only add drift. The marketing pricing page and the in-app plan
   grid both render from `listPlans()`.
2. **Tier rename.** The roadmap's `STARTER` becomes **`CREATOR`** to match the
   operator's Phase 10 wording (and the product's creator-first framing). FREE
   and ENTERPRISE are not self-serve; CREATOR / PRO / AGENCY are.
3. **A hand-rolled Stripe gateway behind `BillingGateway`.** No Stripe SDK, no
   new dependency (same "own the insulation layer" reasoning as ADR-0004 for
   AI). `StripeHttpGateway` calls the Stripe REST API with `fetch` +
   form-encoded bodies; `stripe-signature.ts` verifies webhook signatures with
   `node:crypto` HMAC-SHA256 + a timestamp tolerance window. `fetch` is
   injectable for tests. `NullBillingGateway` is used when Stripe is
   unconfigured: reads are empty, mutations throw `provider_unavailable`, and
   the app runs FREE-for-everyone with limits still enforced.
4. **Entitlements resolve plan defaults + overrides.** `syncPlanEntitlements`
   materialises one PLAN-source `Entitlement` row per meter + per feature from
   the catalog on every plan change; `resolveEntitlements` overlays live
   `OVERRIDE` / `PROMO` rows (support-granted exceptions win). The design doc's
   `UsageLimitOverride` is folded into `Entitlement` with `source = OVERRIDE`.
5. **`usage` is its own module.** `billing` owns plans, Stripe, subscriptions
   and entitlements; `usage` owns the `check` → do work → `record` cycle.
   `usage.enforceUsage` throws `usage_limit_exceeded` (429) **server-side** and
   is called before metered work in Server Actions / Route Handlers — the
   browser never carries a limit or a billing-authorization decision.
   `usage.recordUsage` is idempotent on an `idempotencyKey` (a retried request
   or re-run job never double-counts) and updates a materialized `UsageCounter`
   in the same transaction as the append-only `UsageRecord`; a nightly rollup
   rebuilds counters from the ledger (self-healing). Gauge meters (seats,
   connected accounts) reflect a live count.
6. **Webhooks are idempotent two ways.** A `BillingEvent` ledger whose row id
   IS the Stripe event id — a redelivery finds the row and is skipped before any
   work; plus every handler is an upsert keyed on a Stripe id (subscription id,
   invoice id), so even a torn processing run converges. Bad signature → 400 (no
   retry); handler error → 500 + the ledger row stays `FAILED` for retry on
   redelivery. Unknown event types are recorded `SKIPPED`, not errored.

**Alternatives.** The Stripe Node SDK — rejected: a heavy dependency for a
handful of REST calls we can make directly, and the signature check is ~15 lines
of `crypto`. A `Price` mirror table — rejected: config is the instruction and a
table adds a sync burden. Enforcing limits in the client for snappier UX —
rejected outright by "never trust the browser for billing authorization";
`check` results are also returned so the UI _can_ warn, but the gate is
server-side.

**Consequences.** New tables `Subscription`, `Entitlement`, `UsageRecord`,
`UsageCounter`, `Invoice`, `BillingEvent` (migration `20260913120000_billing`,
additive). New env vars `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` /
`STRIPE_PRICE_*` (all optional). `billing:manage` (already OWNER-only in the
RBAC matrix) guards every billing Server Action. Enforcement + recording is
wired at representative call sites (agent stream + growth-agent job → AI
meters; SEO crawl action → crawl + crawl-page meters; content generation action
→ content-generation meter; OAuth connect routes → connected-accounts meter);
the same one-line pattern extends to the remaining agents and to reports when
that feature ships. The nightly reconcile + counter rollup run inline for now
(ADR-0013 pattern) — no worker queue added.

## ADR-0024 — Monetization intelligence: deterministic opportunity engine, labelled estimates only, never a platform-qualification claim, revenue is user-entered

**Context.** The monetization engine (operator's "Phase 9") turns connected
creator data + a user-provided business profile into a ranked list of
monetization channels (11 of them: platform monetization, sponsorship,
affiliate, digital product, service, membership, subscription, lead generation,
consulting, course, brand partnership). The master instruction says: "Do not
claim that a creator qualifies for a platform monetization program unless the
necessary official criteria/data are available", "Clearly label estimates", "Do
not invent revenue", "Allow users to manually enter revenue sources", "Create
historical tracking".

**Decision.**

1. **The opportunity engine is deterministic.** `buildOpportunities(signals)`
   computes, per channel, the seven required fields — Opportunity, Evidence,
   Audience fit, Estimated difficulty, Estimated potential, Required action,
   Confidence — plus a `priorityScore`. A `ChannelSpec` per channel decides
   applicability, whether it is already active, its actions, and its evidence.
   The model may only refine prose (`MonetizationAnalysis`: overview +
   per-channel description/actions), grounded against a signal fact sheet with
   `checkGroundingFields`; on a grounding failure the model output is dropped
   and the deterministic text stands. The engine works with no AI key.
2. **Every potential / difficulty / audience-fit is a labelled estimate, never
   a currency figure.** `potential` is an enum (`Low | Moderate | High`), not a
   number; `MonetizationOpportunity.isEstimate` defaults `true`;
   `potentialBasis` always states how the estimate was formed and that it "is a
   relative label, not a revenue figure".
3. **PLATFORM_MONETIZATION never asserts the creator qualifies.** Its
   `readiness`, `active`, evidence and actions are derived entirely from the
   careful `assessMonetization` output (official criteria + API data + user
   attestations, `estimate.unmetThresholds` / `unverified`). The description is
   hard-coded to defer the decision to the platform ("This does not confirm you
   qualify — apply in YouTube Studio and YouTube will make the decision"). The
   API never exposes a review decision, so the tool never states one.
4. **Revenue is user-entered only.** `RevenueEntry.createdById` is required (no
   default); the engine only ever _reads_ revenue as a signal, never writes it.
   The dashboard's revenue section is user-entered rows plus derived summaries.
   Deletes are soft (`deletedAt`) so historical tracking survives a correction.
   `getRevenueSummary` produces `byMonth[]` keyed `YYYY-MM` for the history.
5. **Opportunities are deduped on `(organizationId, channel)`.** A re-scan
   refreshes evidence + estimates but keeps a status the user has advanced
   (`IN_PROGRESS` / `ACTIVE` / `COMPLETED` / `DISMISSED`). A recommended action
   can be promoted to a `Task` (reusing the Phase 7 task system); the task never
   targets an external system.

**Alternatives.** A dollar-value potential per opportunity — rejected: it would
be a fabricated projection the master instruction forbids. Letting the model
decide which channels apply — rejected: non-determinism + hallucination risk on
a revenue-adjacent feature. Pulling revenue from platform APIs (AdSense, TikTok)
— deferred: out of scope for Phase 9 and the instruction is explicit that the
user provides or authorizes the data.

**Consequences.** New RBAC action `monetization:manage` (MEMBER+). New tables
`BusinessProfile`, `MonetizationOpportunity`, `RevenueEntry` (migration
`20260912120000_monetization`, additive). New analyst `monetization-analyst`
persisted via `AgentRun`. The scan runs inline in the Server Action
(ADR-0013 pattern); `runMonetizationScanJob` is wired for a future scheduled
re-scan but no worker queue was added. Platform-monetization readiness is only
as good as `assessMonetization`, which is itself deliberately conservative.

## ADR-0023 — Content repurposing: user-provided source only, immutable linear versions, never auto-publish

**Context.** The content repurposing engine (operator's "Phase 8") takes a
YouTube video / URL / transcript / user text and generates 13 deliverable types
through the pipeline SOURCE → ANALYSIS → KEY IDEAS → ANGLES → PLATFORM CONTENT →
APPROVAL → PUBLISH/SCHEDULE. The master instruction says "Do not automatically
publish", "Allow the user to edit generated content", "Store content versions",
and "Create an audit trail".

**Decision.**

1. **Source is user-provided or already synced — the engine does not fetch or
   transcribe.** A "video URL" is metadata only; the user pastes the transcript /
   title / description. A synced `YouTubeVideo` contributes its stored title /
   description / tags. This avoids a transcript-scraping surface (ToS, captions
   API availability, cost) and keeps the engine a pure text transformer.
2. **Immutable, linear version history.** Each `ContentAsset` has
   `ContentAssetVersion` rows numbered from 1; `currentVersionId` points at the
   live one. An edit, regeneration, or revert **appends** a version — history is
   never rewritten. A revert appends a _copy_ of the target version.
3. **An edit invalidates approval.** Editing / reverting / regenerating an
   asset resets its status to `DRAFT` and clears approval / schedule / publish
   fields, so an approval always refers to the content that was approved.
4. **The engine never publishes.** `markAssetPublished` is a status marker the
   user sets after posting the content themselves. `scheduleAsset` records
   intent + a future date; the worker's `sweep.scheduled` job only audits due
   assets, it does not post. For TikTok, users go through the existing gated
   Content Posting approval flow.
5. **Light grounding for a creative stage.** `sourceQuote`s must be verbatim
   (non-matching ones are dropped, not failed); guarantee phrasing falls back to
   a deterministic template; otherwise the model may paraphrase and invent
   hooks. Every stage has a deterministic path so the engine works with no AI key.

**Alternatives.** Fetching captions via the YouTube API — deferred: not always
available, adds quota + a failure mode, and users often have a better transcript.
A single mutable "content" blob per asset — rejected: the spec requires version
history and an audit trail. An auto-publish path behind a confirm — rejected by
the master instruction.

**Consequences.** New RBAC action `content:manage` (MEMBER+). New tables
`RepurposeProject`, `ContentAsset`, `ContentAssetVersion` (migration
`20260911120000_content_repurposing`). New worker queue `content-pipeline`.
Large source bodies live inline (`@db.Text`, 200k cap); object-storage offload
and a real scheduler are follow-ups.

## ADR-0022 — Unified Growth Agent: a fixed capability registry, grounded synthesis, no chain-of-thought, and no external-action execution

**Context.** Phase 7 asks for one conversational agent at `/app/agent` that
plans across YouTube / TikTok / SEO, combines specialist results, streams a
reply, keeps controlled memory, and turns recommendations into tasks — without
exposing private reasoning and without letting the agent change external
systems. `packages/ai` has no model-driven tool loop yet.

**Decision.**

1. **Fixed capability registry, not a model tool-loop.** `agent/capabilities.ts`
   is a closed set of seven tenant-scoped wrappers over existing specialists.
   The planner (deterministic keyword router, model-refined) picks ≤ 5; the
   orchestrator runs them. No capability receives a raw DB handle beyond its
   `CapabilityContext`, and there is no capability that mutates anything.
2. **Grounded synthesis with a deterministic fallback.** The model emits only
   `GrowthAgentResponse` (analysis summary · evidence · decisions ·
   recommendations · actions), grounded against the id-tagged evidence via the
   shared `checkGroundingFields`. One repair; then the capability results are
   assembled deterministically. The reply text is streamed by `streamText`, or
   composed deterministically when no model is configured.
3. **No chain-of-thought.** The response schema has no `thinking` /
   `reasoningSteps` field. `decisions` is one line per capability used (what +
   why). The planner's `rationale` is one sentence.
4. **The orchestrator never executes an external action.** A recommendation can
   become an internal `Task`. Anything that would change an external account
   (TikTok publish, YouTube metadata) is emitted as a `proposedAction` with
   `kind: 'external'` and `requiresConfirmation: true`; the user performs it in
   that feature's own approval flow. This reuses the Phase 4 publish-approval
   and `Recommendation.requiresApproval` gates rather than building a new
   external-action executor.
5. **Controlled memory** — six `OrgMemory` kinds only, allowlisted + length-capped
   - secret-redacted at write time (AI-ARCHITECTURE.md §5).

**Alternatives.** A model-driven `generateWithTools` loop — deferred to the
general orchestrator; harder to bound and ground. Letting the agent call the
publish / metadata APIs after a confirm click — rejected: it duplicates
existing approval flows and widens the blast radius; a proposed action that
links to the real screen is safer. Free-form capability discovery — rejected:
an unbounded plan is hard to budget and audit.

**Consequences.** The agent is fully usable with zero AI spend (deterministic
planning + assembly + reply). New schema: `AIConversation`, `AIMessage`,
`OrgMemory`, `Task` (migration `20260910120000_growth_agent`). Adding richer
multi-step planning later means building the general orchestrator, not
rewriting this.

## ADR-0021 — AI SEO Agent: deterministic engine + restricted read-only tools; the model is narrative-only with a graceful fallback

**Context.** Phase 6 asks for an "AI SEO Agent" that answers free-form questions,
ranks recommendations, builds action plans and analyses machine readability —
without crawling when crawl data already exists, and without ever modifying a
production site or promising rankings. `packages/ai` has no model-driven tool
loop (that is Phase 7).

**Decision.**

1. **Restricted tools, no write path.** `seo/agent-tools.ts` is a closed
   allowlist of nine read-only, org-scoped `seo.get_*` tools. There is no write
   tool, so "the AI cannot modify production websites" is structural, not a
   prompt instruction. `executeSeoTool` rejects any other name and Zod-validates
   input. The agent calls these itself to build an evidence bundle — it does not
   crawl.
2. **Deterministic ranking + analysis.** `recommendation-engine.ts` computes the
   priority score from six published factors and buckets the four action plans;
   `ai-readability.ts` computes the nine machine-readability signal scores. No
   model is involved in any number.
3. **Model is narrative-only, and optional.** With an AI provider, one
   `generateObject` pass refines wording and answers the question, grounded
   against a deterministic fact sheet via the shared `checkGroundingFields`. If
   grounding fails after one repair, the model output is **dropped** and
   deterministic templates are used (`narrativeSource = 'deterministic'`,
   `grounded = false`). Without a provider the agent runs fully.

**Alternatives.** A model-driven tool-calling loop — deferred to Phase 7's
orchestrator; also harder to keep grounded and bounded. Letting the model
produce the rankings — rejected: rankings must be explainable and reproducible,
and a hallucinated priority is a real harm. Failing the whole run on an
ungrounded narrative (as the `seo-auditor` does) — rejected here: a Q&A agent
should still return its deterministic analysis, and nothing unsafe ships because
the numbers are model-independent.

**Consequences.** The agent is useful with zero AI spend. Adding richer
model reasoning later means adding a tool loop in Phase 7, not rewriting this.
Two small additive `CrawlPage` columns (`landmarkCount`, `hasMainLandmark`,
`jsonLdEntities`) and a written-back `inboundInternalCount` were needed so the
machine-readability checks are concrete rather than hand-wavy. `Recommendation`
gained `priorityScore` / `actionPlan` / `affectedUrlCount` / `businessImportance`.

## ADR-0020 — SEO scoring: category scores with a published weighting, never one opaque number

**Context.** Phase 5 requires a technical-SEO score but explicitly forbids "a
meaningless single score only", and the product must never imply a ranking
guarantee.
**Decision.** `scoring.ts` computes nine independent 0–100 **category** scores
(crawlability, indexability, architecture, internal linking, metadata,
structured data, performance, security, internationalization). Each starts at
100 and loses points per issue: `severityPenalty × confidence × (0.4 + 0.6·√(affectedFraction))`,
so a site-wide issue costs more than a one-page issue, with diminishing returns.
The overall score is the weighted average; the weight table and the
per-severity penalties are returned in the score object and rendered in the UI.
A `note` field states the score is diagnostic, not a ranking prediction.
**Alternatives.** A single black-box score — rejected by the spec and unhelpful.
ML-learned weights — rejected: no training signal, and opacity is the thing we
are avoiding. Linear penalties without the affected-scale term — rejected:
over-punishes large sites for one-page problems.
**Consequences.** Weights are a product decision recorded here; changing them is
an ADR amendment. Scores are comparable across crawls of the same site.

## ADR-0019 — Crawler SSRF defense: resolve-then-pin, reject mixed DNS, no XML DOM for sitemaps

**Context.** The crawler is the highest-risk egress (SECURITY.md §1/§7). It must
resist SSRF, DNS rebinding, redirect-based pivots, decompression bombs and
hostile XML.
**Decision.** `ssrf.ts` is the single authority. For every URL **and every
redirect hop**: (1) scheme ∈ {http,https}, port ∈ {80,443}; (2) reject
localhost / `*.internal` / `*.local` / metadata hostnames and literal private
IPs up front; (3) resolve DNS in-process via an **injectable** `lookup`, and
validate _every_ returned address against an IPv4+IPv6 blocked-range table
(loopback, private, CGNAT, link-local incl. `169.254.169.254`, ULA, multicast,
IPv4-mapped/NAT64 forms); (4) if the answer is **mixed** public+private, refuse
the whole request (rebinding tell); (5) return the validated IPs so the fetch
transport connects **pinned to a resolved IP** with SNI/Host still the real
hostname (defeats the resolve→connect TOCTOU). The fetch client strips
`Authorization`/`Cookie` on cross-origin redirects, caps the body and the
_decompressed_ size (`zlib maxOutputLength`), and only parses textual content
types. Sitemaps are parsed with `fast-xml-parser` with **entity expansion
disabled** and a byte cap — no DOM parser is fed untrusted XML.
**Alternatives.** Trust the OS resolver + a post-hoc IP check — rejected: the
TOCTOU window is exploitable. A blocklist of hostnames only — rejected: trivially
bypassed by an attacker-controlled DNS record. A full XML DOM parser with
entities on — rejected: billion-laughs risk.
**Consequences.** `lookup`/`transport` injection makes the whole pipeline
unit-testable without sockets. A site behind split-horizon DNS that legitimately
returns a private A record cannot be crawled; that is the intended trade.

## ADR-0018 — In-memory crawl frontier now; Redis frontier deferred

**Context.** SEO-ENGINE.md describes a Redis sorted-set frontier for a
distributed crawl. Phase 5 must ship a usable crawler, and a single bounded
crawl (≤ a few hundred pages for most tiers) fits in one process.
**Decision.** `MemoryFrontier` implements a small `Frontier` interface: a
seen-set for dedupe, a depth-then-discovery-order queue, and a hard `maxPages`
admission cap. `crawler.ts` drives it with a bounded-concurrency pool + a
per-host rate limiter. The `Frontier` interface is the seam a Redis-backed
implementation would fill. Pause/resume does not persist the frontier — a resume
re-runs the crawl pass on the same `Crawl` row (pages are upserted, so it is
idempotent).
**Alternatives.** Redis frontier from day one — rejected: forces every dev/deploy
to run Redis for a basic feature and adds a "stuck queue" failure mode. Persist
the frontier to Postgres between pauses — deferred: heavier than the value for
the current crawl sizes.
**Consequences.** A very large crawl (agency tier, 200k pages) will need the
distributed frontier; that work is tracked in ROADMAP Phase 6's "deferred"
list. A process crash mid-crawl loses in-flight progress (the `Crawl` row stays
`RUNNING` until re-run).

## ADR-0017 — TikTok publishing: PULL_FROM_URL + a duplicate-publish guard

**Context.** Phase 4 must "implement authorized publishing … where the
application's approved scopes/products permit it", require explicit approval,
never silently publish, and handle duplicate publishing.
**Decision.** Use the Content Posting API **Direct Post** with the
`PULL_FROM_URL` source (a public https video URL the app supplies). Every post is
a `TikTokPublish` row that starts `AWAITING_APPROVAL`; `approveAndSubmit`
refuses unless `approve === true` and re-checks the guard. The **duplicate
guard** is `sha256(accountId | sourceUrl | caption | sorted hashtags)` compared
against any non-terminal (`AWAITING_APPROVAL`/`SUBMITTED`/`PROCESSING`/
`PUBLISHED`) row for the same account. Privacy defaults to `SELF_ONLY`; the
selector notes that `PUBLIC_TO_EVERYONE` needs an audited TikTok app.
**Alternatives.** `FILE_UPLOAD` (browser → our server → TikTok) — deferred: it
needs multipart upload plumbing and storage; PULL_FROM_URL ships the flow now.
A DB unique constraint on the content hash — rejected: we want to allow a
_retry_ after a `FAILED`/`CANCELLED` attempt, which a hard unique index would
block. Auto-publish mode — not built; every post needs a click.
**Consequences.** Users must host the source video somewhere TikTok can reach.
The guard is enforced in code and covered by unit + integration tests.

## ADR-0016 — Provider-agnostic OAuth via a small registry

**Context.** Phase 3's connection layer hard-coded Google's refresh/revoke.
TikTok needs the same lifecycle with different endpoints and a different token
shape.
**Decision.** `integrations/oauth-token.ts` defines `OAuthTokenResponse` (a
normalized shape) and a `ProviderOAuth` registry keyed by `IntegrationProvider`.
`google.ts` and `tiktok-oauth.ts` `registerProviderOAuth(...)` on import;
`withFreshAccessToken` / `disconnectConnection` dispatch through
`providerOAuth(connection.provider)`. `integrations/index.ts` side-effect-imports
both so the registry is populated.
**Alternatives.** A `switch (provider)` in `connections.ts` — rejected: couples
the generic layer to every provider and grows unboundedly. One class per
provider duplicating the whole connection lifecycle — rejected: the storage,
encryption, health, and refresh-skew logic are identical.
**Consequences.** A new provider adds one file that registers itself. Tests
register a fake `ProviderOAuth` rather than mocking a specific module.

## ADR-0015 — TikTok PKCE verifier in a signed HttpOnly cookie

**Context.** TikTok's v2 OAuth expects PKCE. The `code_verifier` must persist
between the connect redirect and the callback (two separate requests) and must
not appear in the auth URL.
**Decision.** The connect route sets a signed (HMAC-`AUTH_SECRET`), HttpOnly,
`SameSite=Lax`, 10-minute cookie (`tt_pkce`) scoped to
`/api/integrations/tiktok`; the callback reads and clears it.
**Alternatives.** Put the verifier in the signed `state` — rejected: `state`
travels in the auth URL to TikTok, exposing the verifier. A DB row keyed by a
nonce — rejected as heavier than a cookie for a 10-minute secret. Skip PKCE
(confidential client) — rejected: PKCE is defense-in-depth and TikTok expects
it.
**Consequences.** The callback fails cleanly ("the sign-in attempt expired") if
the cookie is missing or stale, prompting a retry.

## ADR-0014 — Analyst output is grounded, not trusted

**Context.** The YouTube Analyst Agent (master instruction, section D/J) must
produce explainable recommendations and must never fabricate analytics or make
guarantees.
**Decision.** The model receives **only** a fact sheet of ids + values we
computed, and must emit a schema where every analytical item lists
`evidenceFactIds`. A deterministic **grounding check** runs before persistence:
(1) cited fact ids must exist; (2) every number in free text must match a fact
value within ±2 % or be an obviously-safe number; (3) no guarantee phrasing.
One repair attempt is allowed; a second failure fails the `AgentRun` and
throws — ungrounded content is never stored or shown. Thin data (< 3 videos)
skips the model entirely and returns a deterministic minimal report.
**Alternatives.** Trust schema-valid output — rejected: schema validity does not
prevent invented numbers or guarantees. A second "critic" model pass — rejected
for MVP: slower, costlier, and still probabilistic; the deterministic check is
cheap and auditable. Post-hoc disclaimers only — rejected: does not stop the
false claim being shown.
**Consequences.** The agent can be "too cautious" and drop borderline items; we
accept that trade. The check is unit-tested against hallucinated fixtures.
Other analyst agents (TikTok, SEO) will reuse the same pattern.

## ADR-0013 — YouTube sync runs inline now, with a worker queue wired

**Context.** `ARCHITECTURE.md` says long work goes to the worker, not inline.
A single-channel YouTube sync is bounded (~5–15 API calls, seconds) and the
feature must be usable without operating a separate worker process during
early development.
**Decision.** The "Sync now" / "Run analysis" Server Actions run the bounded
operation **inline**. The identical `youtube.runYouTube*` functions are also
registered on a `youtube-sync` BullMQ queue in `apps/worker`, so moving to the
queue later is a one-line change at the call site.
**Alternatives.** Queue-only from day one — rejected: forces every dev/deploy to
run the worker for a basic feature, and adds a "queued forever" failure mode
with no worker. Never add the worker path — rejected: large catalogues (agencies
with many big channels) will need offloading.
**Consequences.** A pathological very-large channel could make one Server Action
slow; the per-run video cap (`maxNewVideos`) and quota slice bound it. The
switch to queue-by-default is tracked for the phase that adds scheduled syncs.

## ADR-0012 — `packages/config` folded into `packages/ui`; `.js` specifiers kept

**Context.** The planned `packages/config` (ADR-0002/0003 layout) would hold
only a Tailwind preset in Phase 2. Separately, workspace packages use
NodeNext-style `.js` import specifiers that resolve to `.ts` source, which
webpack does not remap by default.
**Decision.** (a) Ship the Tailwind preset from `packages/ui/tailwind-preset`
and defer a dedicated `packages/config` until it earns its keep (shared
eslint/tsconfig presets are still centralised at the repo root). (b) Keep `.js`
specifiers (correct for the NodeNext worker and for a future ESM publish) and
teach Next to resolve them via `webpack.resolve.extensionAlias` +
`turbopack.resolveExtensions` in `apps/web/next.config.mjs`.
**Alternatives.** Create the near-empty `packages/config` now — rejected as
ceremony. Strip all `.js` specifiers — rejected: breaks the worker's NodeNext
resolution.
**Consequences.** `CLAUDE.md` / `ARCHITECTURE.md` note the fold. If a second
consumer needs the shared eslint/tsconfig as a package, `packages/config` gets
created then with its own ADR.

## ADR-0011 — JWT session strategy (supersedes the "database sessions" part of ADR-0007)

**Context.** ADR-0007 specified Auth.js **database sessions**. But Next.js
middleware runs on the Edge runtime, where Prisma cannot run. Protecting
`/app/**` and `/admin/**` in middleware therefore cannot consult a
database-backed session. Doing the check only in a Node server component would
let unauthenticated requests reach the route before the redirect.
**Decision.** Use the **JWT session strategy**. The Prisma adapter is still used
for users, accounts, and email verification tokens. Middleware
(`config.edge.ts`) verifies the signed JWT with no I/O and enforces route
protection via the `authorized` callback. The JWT carries `uid`, the user's
`orgs` + roles, `isPlatformStaff`, and `sv` (a copy of `User.sessionVersion`).
The `/app` server layout does the **authoritative** check: it re-reads
`User.sessionVersion` and `deletedAt` from the database and redirects to
`/login?reason=session_expired` on a mismatch. Bumping `User.sessionVersion`
(e.g. on a forced sign-out or role revocation) invalidates every issued token
within its 8-hour max age.
**Alternatives.** Database sessions + a Node-only guard in every server layout —
rejected: no edge-fast redirect, and easy to forget on a new route. Database
sessions with a short-TTL edge cache of session ids — rejected as premature
complexity. A third-party auth vendor that offers edge session verification
(Clerk) — already rejected in ADR-0007 for cost/lock-in.
**Consequences.** Sign-out is not instantaneous across devices unless
`sessionVersion` is bumped; the 8-hour max age bounds the window. Session
contents are visible to anyone who can read the cookie's JWT payload (not its
signature) — so only ids, roles, and flags go in it, never secrets. Enterprise
SSO/SCIM via WorkOS is unaffected (it plugs in as a provider). `SECURITY.md` §2
and `ARCHITECTURE.md` §1 updated.

## ADR-0010 — Monetization: Stripe, subscription + metered usage

**Context.** Section on monetization requires subscriptions, checkout, billing
portal, webhooks, invoices, and usage limits, with **no card data stored**. The
expensive resources (AI tokens, crawled pages, connected properties) vary wildly
per customer.
**Decision.** Stripe as the sole payment processor. Seat-inclusive tiers (Free,
Starter, Pro, Agency, Enterprise) plus **metered usage** for `AI_TOKENS`,
`CRAWL_PAGES`, `CONNECTED_PROPERTIES`, `AGENT_RUNS`, `REPORT_EXPORTS`, `SEATS`.
Limits derived from `tier` → `Entitlement`, enforced centrally by the `usage`
module (`usage.check` before, `usage.record` after). Stripe holds all PCI scope;
we store only `stripeCustomerId`/`stripeSubscriptionId` and mirrored invoice
metadata.
**Alternatives.** Paddle/Lemon Squeezy (merchant-of-record, simpler tax) —
reconsider for non-US expansion; rejected now for less flexible metering and
API maturity. Pure seat pricing — rejected: doesn't cover AI/crawl cost
variance. Home-grown metering only — rejected: Stripe usage records + invoicing
are a solved problem.
**Consequences.** Hard dependency on Stripe webhooks + a reconcile job. Tax via
Stripe Tax. Metering correctness is now a first-class concern (idempotency keys,
self-healing counters).

## ADR-0009 — SEO crawler is bounded and never a fetch proxy

**Context.** The crawler is the app's largest SSRF surface; the spec forbids it
becoming "an unrestricted SSRF proxy."
**Decision.** Ownership-gated crawling (verified domain beyond a shallow public
sample), in-process DNS resolution with private/loopback/link-local/metadata IP
blocking re-checked on every redirect, `Host`-pinned connections to the
validated IP (DNS-rebinding safe), `http(s)`+80/443 only, capped
redirects/size/time, no credential passthrough, and a **network-isolated crawl
worker pool**. There is no endpoint that fetches an arbitrary user URL and
returns the body. Full spec in `SEO-ENGINE.md` §2.
**Alternatives.** Third-party crawl API (e.g. a hosted crawler) — rejected for
cost at scale, data-residency, and loss of control over exactly these safety
properties. Allow arbitrary URL fetch with a blocklist — rejected: blocklists
are bypassable; allowlist + ownership is the safe default.
**Consequences.** More infra (isolated egress pool). Third-party sites get only
a shallow sample. Worth it.

## ADR-0008 — BullMQ on Redis for background jobs; Redis for cache

**Context.** Spec requires background workers for long-running operations and a
Redis-backed queue or equivalent, plus caching.
**Decision.** BullMQ (Redis) with queues per domain, processed by a dedicated
`apps/worker` process. Same Redis (separate logical DB) for response/computation
cache, rate-limit token buckets, idempotency keys, and crawl-frontier/dedupe
sets. Repeatable jobs for schedulers.
**Alternatives.** Temporal / Inngest — excellent DX and durability, rejected for
MVP due to added infra/vendor and cost; revisit if workflow complexity grows.
pg-boss (queue in Postgres) — simpler ops, rejected because we already need
Redis for cache/rate-limit and BullMQ's rate-limiting/priorities/repeatable jobs
fit the crawler and sync workloads. Cloud queue (SQS) — rejected for weaker
local-dev story and no built-in scheduling.
**Consequences.** Redis is a hard dependency and a scaling axis. Worker is a
separately deployed, separately scaled service.

## ADR-0007 — Auth.js (NextAuth v5) with database sessions

**Context.** Spec requires a secure production authentication solution, RBAC,
tenant isolation, and later enterprise SSO.
**Decision.** Auth.js v5 + Prisma adapter, **database sessions**, email
magic-link + Google OAuth for MVP. RBAC and tenancy are **our** concern
(`Membership.role` + `authorize()` + RLS), not the auth library's. Enterprise
SSO/SCIM will be added via **WorkOS** as a separate provider without changing the
session model.
**Alternatives.** Clerk / WorkOS AuthKit / Stytch (hosted) — faster to start,
rejected for MVP due to per-MAU cost at scale, data-model lock-in (user/org
lives in the vendor), and less control over session/RLS integration; WorkOS kept
as the SSO upgrade path. Lucia — lightweight and flexible, rejected because it is
winding down as a maintained library. Roll-our-own — rejected: needless risk.
**Consequences.** `next-auth@5` is pre-1.0 (pinned exact; migration watch).
Database sessions add a DB read per request (mitigated by short-TTL cache).
We own more of the auth surface (a deliberate trade for control).

## ADR-0006 — Next.js server layer for the API; no separate backend framework

**Context.** Spec allows "Next.js server/API layer **or** dedicated backend
where justified."
**Decision.** Use Next.js Route Handlers + Server Actions for the application
API, backed by a framework-agnostic `packages/services` layer. A **dedicated
Node worker** exists for jobs (not HTTP). No Nest/Express/Fastify API service
for MVP.
**Alternatives.** Separate Nest/Fastify API — rejected for MVP: doubles deploy
surface and auth wiring for no current benefit; the service layer means we can
extract one later with minimal churn if a public API or non-web client demands
it. tRPC — strong typed-RPC option; deferred: Server Actions cover UI mutations
and we want plain REST handlers for webhooks/OAuth/streaming anyway. Adding tRPC
for internal calls is a low-risk later addition.
**Consequences.** Business logic must stay in `packages/services` (lint-enforced)
so the "extract a backend later" path stays open. Streaming/SSE handled by Route
Handlers.

## ADR-0005 — Component system: Radix primitives + local shadcn-style wrappers

**Context.** Spec requires an accessible component system.
**Decision.** `packages/ui`: Radix UI primitives wrapped in local, Tailwind-
styled components (the shadcn/ui pattern — copy-in, not a dependency), with a
shared Tailwind preset and design tokens (CSS variables, light/dark).
**Alternatives.** MUI / Mantine / Chakra — rejected: heavier runtime, opinionated
theming, harder to match a custom design. Headless UI — viable, Radix chosen for
broader primitive coverage and better composition. Pure hand-rolled — rejected:
accessibility is hard to get right without primitives.
**Consequences.** We own the component code (maintenance + freedom). Must keep
Radix versions current for a11y fixes.

## ADR-0004 — Vercel AI SDK behind our own `AIProvider` interface

**Context.** Section I: provider-agnostic AI layer (text, structured JSON, tool
calling, streaming, embeddings, model selection, usage + cost).
**Decision.** `packages/ai` defines `AIProvider`; concrete providers are thin
factories over the Vercel AI SDK (`ai` + `@ai-sdk/{anthropic,openai,google}`).
No `apps/*` file imports a provider SDK directly. Tool-calling gets a first-class
`generateWithTools` in Phase 7 (until then the orchestrator loops
`generateObject`).
**Alternatives.** LangChain.js — rejected: heavy abstractions, churn, and we
want a minimal surface we fully control. Direct provider SDKs only — rejected:
re-implements streaming/tool plumbing per provider. LiteLLM-style proxy —
rejected for an extra hop/service at this stage.
**Consequences.** We depend on the AI SDK's stability; our interface is the
insulation layer if we drop it. We own the pricing table and usage recording.

## ADR-0003 — Turborepo monorepo, pnpm workspaces

**Context.** Modular architecture; web + worker + shared domain logic.
**Decision.** One repo: `apps/{web,worker}` + `packages/{core,db,ai,services,ui,
config,observability}`, orchestrated by Turborepo. Packages consumed as TS
source (`transpilePackages`).
**Alternatives.** Polyrepo — rejected: cross-cutting changes become multi-PR
dances; shared types drift. Nx — comparable; Turborepo chosen for lighter
config and Vercel alignment.
**Consequences.** One `pnpm install`, shared tooling, atomic changes. Slightly
more build-graph config; CI caches per task.

## ADR-0002 — PostgreSQL + Prisma

**Context.** Spec: PostgreSQL; Prisma or an equivalent strongly-typed ORM;
migrations.
**Decision.** PostgreSQL 16 + Prisma 6. Checked-in migrations, `directUrl` for
migrate, expand/contract change discipline. `pgvector` for semantic memory.
Postgres RLS for defense-in-depth tenant isolation.
**Alternatives.** Drizzle — lighter, SQL-first, great types; rejected for MVP
because Prisma's migration workflow, tooling, and team familiarity reduce risk
on a large schema. Kysely — query builder only, would still need a migration
tool. MikroORM — rejected: smaller ecosystem.
**Consequences.** Prisma's query-layer limits (complex analytics via
`queryRaw`, reviewed). Watch Prisma 7 changes. Drizzle remains a viable future
migration if Prisma becomes a bottleneck.

## ADR-0001 — TypeScript everywhere (supersedes an early "Python backend" idea)

**Context.** An early conversation floated a Python backend + Next.js UI. Master
instruction section H: "Use: TypeScript."
**Decision.** All-TypeScript: Next.js (web + API), Node/TS worker, TS packages.
**Alternatives.** Python (FastAPI) backend for AI/crawl — rejected: violates the
spec, splits the type system, doubles tooling. Any Python-only ML need later
would be isolated behind a service boundary with its own ADR.
**Consequences.** One language, one lint/test/type toolchain; every spec code
example applies directly.

---

## Open decisions (tracked, not yet made)

| #    | Question                                                                                                                     | Needed by |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | --------- |
| OD-1 | Hosting target: Fly.io vs Render vs AWS ECS/EKS (affects egress isolation for the crawl pool, managed Postgres/Redis choice) | Phase 2   |
| OD-2 | Object storage: Cloudflare R2 vs AWS S3 (egress cost vs ecosystem)                                                           | Phase 5   |
| OD-3 | Email provider: Resend vs Postmark vs SES (deliverability vs cost)                                                           | Phase 3   |
| OD-4 | Final tier prices + limit numbers (with finance)                                                                             | Phase 4   |
| OD-5 | Embeddings provider (OpenAI vs Google vs self-hosted) and pgvector index type                                                | Phase 7   |
| OD-6 | Whether to adopt tRPC for internal calls or stay REST + Server Actions                                                       | Phase 7   |
| OD-7 | TikTok API tier actually granted → which analytics/publishing features are in scope                                          | Phase 9   |
