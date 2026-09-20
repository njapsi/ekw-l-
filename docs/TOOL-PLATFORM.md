# TOOL-PLATFORM.md — Tool Ecosystem & Orchestration (Phase 5)

Architecture reference for the Phase 5 tool platform: Capability Discovery,
the Policy Engine, the Tool Executor, and the research tools. MCP has its
own document, `docs/MCP.md`. See `docs/PHASE-5-REPORT.md` for what was
verified and what was deferred; ADR-0055 for the design rationale.

## 1. The shape of the problem

Before this phase, "can this agent do X?" was answered in at least three
different places depending on the tool: `assertCapabilityUsable` +
`assertGovernanceAllows` inside `integration-tools.ts` for native tools,
nothing at all for a would-be research tool, and nothing at all for MCP
(which didn't exist). This phase's job was not to replace any of those —
the native path is already audited and correct — but to give every tool
kind, including two that had none, one deterministic decision surface, and
to give every tool kind, including native ones that had none, real
per-call metering.

```
AGENT
  │
  ▼
CAPABILITY DISCOVERY (agent/capability-discovery.ts)
  │  "what can this org do right now, and why not otherwise"
  ▼
TOOL SELECTION (the model, or a planner — unchanged from Phase 4)
  │
  ▼
TOOL EXECUTOR (agent/tool-executor.ts)
  │  rate limit → usage meter → dispatch by kind → standardized envelope
  ├── native  → runIntegrationTool (unchanged — its own governance/capability checks)
  ├── research → runResearchTool (Policy Engine: trivial READ-level allow)
  └── mcp.*   → executeMcpTool (Policy Engine: governance('MCP') + both enable gates)
  │
  ▼
ToolResultEnvelope (agent/tool-envelope.ts)
```

## 2. Capability Discovery (`agent/capability-discovery.ts`)

`discoverCapabilities(organizationId)` returns every capability the org
could exercise right now, grouped by integration, each with:

- `id` — the capability id (`wordpress.publish`, `mcp.analytics.search`, …)
- `category` — READ / ANALYZE / GENERATE / CREATE / UPDATE / PUBLISH / DELETE
- `outcome` — the Policy Engine's outcome for it
- `reason` — always concrete ("Reconnect required.", never a bare
  "unavailable")

It is a **read composition**, not a new capability model: it calls the
Connection Center (`integrations/center.ts`, unchanged) for native
capabilities and `mcp.listEnabledMcpTools` for MCP ones, then runs each
through `governance.decide()` and `policy-engine.evaluateToolPolicy()`.
`usableCapabilityIds()` is the flat, planner-facing filter — only
`ALLOW`/`REQUIRE_APPROVAL` ids, never something that would fail
immediately (Part 51: don't offer the model a tool that can't run).

**Not wired into the live growth-agent planner this phase** — `planner.ts`
still uses its fixed 7-capability `CAPABILITY_IDS` enum from Phase 7/4,
unchanged. `discoverCapabilities`/`usableCapabilityIds` are built, tested,
and exposed via `GET /api/agent/capabilities`, ready for a future phase to
use for tool filtering; wiring them into the live planner is listed as a
recommended next step (§19 of `docs/PHASE-5-REPORT.md`), not done, to avoid
changing the live agent's tool-selection behavior in the same phase that
built the primitive — the same "ship the primitive, defer the live wiring"
pattern Phase 4 used for `packages/ai`'s tool-calling support.

## 3. The Policy Engine (`agent/policy-engine.ts`)

`evaluateToolPolicy(input): ToolPolicyDecision` is a **pure function** —
no I/O, no database, no Redis. It takes pre-resolved facts (governance
decision, connection state, a rate-limited flag, a quota-exceeded flag)
and returns one of seven outcomes, in this precedence order:

1. **DENY** — governance says no (org disabled the action, or disallowed
   the agent entirely for this integration). Outranks everything else: an
   explicit organizational policy choice is not a transient condition a
   retry can fix.
2. **REAUTH_REQUIRED** — the connection state is exactly `REAUTH_REQUIRED`.
3. **UNAVAILABLE** — any other not-currently-usable connection state
   (`NOT_CONNECTED`, `CONNECTING`, `EXPIRED`, `ERROR`, `DISCONNECTED`).
4. **RATE_LIMITED** — too many calls to this tool recently (abuse
   protection, not a billing signal — checked before quota because it's
   cheaper and unrelated to the org's plan).
5. **QUOTA_EXCEEDED** — the org's plan usage limit for tool calls is spent.
6. **REQUIRE_APPROVAL** — governance says this action needs a human
   decision.
7. **ALLOW** — nothing stood in the way.

A `'NONE'` connection state exists for tools with no connected-account
concept at all (research) — it always falls through to the next check,
never blocking on a connection that was never expected to exist.

**What the Policy Engine does _not_ do**: it does not re-decide native
tool authorization. `integration-tools.ts`'s own `assertCapabilityUsable`/
`assertGovernanceAllows` inside each tool's `execute()` is unchanged and
is still what actually gates a native tool call — the Policy Engine's
outcome vocabulary is the _conceptual_ mapping for those same decisions
(`DENY` ≈ a thrown `permission_denied` AppError, `UNAVAILABLE` ≈
`CapabilityUnavailableError`, etc.), used directly for MCP and research
tools, and used by `capability-discovery.ts` to compute the _display_
outcome for native capabilities without duplicating the enforcement logic
that already lives inside each tool.

`floorDecision(level)` is the capability-level-only fallback for a tool
kind with no governance bucket of its own (used by research: READ/DRAFT
never need approval, WRITE/PUBLISH/DANGEROUS always do — the same floor
`integrations/contract.ts`'s `APPROVAL_POLICY` already enforces for native
capabilities).

## 4. The Tool Executor (`agent/tool-executor.ts`)

`executeAgentTool(ctx, toolName, input): Promise<ToolResultEnvelope>` is
the one function that should dispatch every tool call. It:

1. Records `TOOL_SELECTED` (only if `ctx.agentRunId` is supplied — a
   standalone call, like an admin's "test this MCP tool" button, has no
   run to attach events to).
2. Rejects an unregistered name outright (`kindOf()` checks the closed
   native allowlist, the closed research allowlist, or the `mcp.` prefix —
   nothing else is dispatched).
3. Checks a per-org-per-tool rate limit (`security.checkRateLimit`,
   30/minute) and the org's `TOOL_CALLS` usage quota — **before** doing
   anything, so a blocked call never gets metered (nothing ran).
4. Records `TOOL_AUTHORIZATION_CHECK` then `TOOL_STARTED`.
5. Dispatches by kind:
   - **native** → `runIntegrationTool` unchanged.
   - **research** → `runResearchTool` unchanged.
   - **mcp.\*** → `mcp/execute.ts`'s `executeMcpTool`, which already
     returns a `ToolResultEnvelope` itself.
6. Wraps whatever the native/research path threw (or returned) into the
   standardized envelope: a thrown `AppError` with code `permission_denied`
   becomes `BLOCKED`/`POLICY_DENIED`; `usage_limit_exceeded` becomes
   `BLOCKED`/`QUOTA_EXCEEDED`; `validation_failed` becomes
   `FAILED`/`VALIDATION_FAILED`; anything else becomes a generic
   `FAILED`/`INTERNAL_ERROR` with the raw message dropped unless the
   `AppError` is marked `expose: true` — a raw exception message never
   reaches the caller.
7. Records `TOOL_COMPLETED` or `TOOL_FAILED` and meters the call (unless
   it was `BLOCKED` or `REQUIRES_APPROVAL` before ever running).

**Not wired into the live growth-agent orchestrator this phase** — same
disclosure as Capability Discovery above. `runGrowthAgentTurn` still calls
its fixed capability functions directly, not `executeAgentTool`. This
function is built, unit-tested, and is the obvious integration point for a
future phase that wires model-driven tool-calling into the live loop.

## 5. The tool result/error envelope (`agent/tool-envelope.ts`)

One shape for every tool outcome:

```ts
interface ToolResultEnvelope<T> {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'BLOCKED' | 'REQUIRES_APPROVAL';
  tool: string;
  provider: string;
  durationMs: number;
  data?: T;
  warnings: string[];
  error?: ToolErrorEnvelope;
  resourceReferences: string[];
}
```

`ToolErrorEnvelope.code` is one of `POLICY_DENIED | REAUTH_REQUIRED |
RATE_LIMITED | QUOTA_EXCEEDED | UNAVAILABLE | VALIDATION_FAILED | TIMEOUT |
PROVIDER_ERROR | INTERNAL_ERROR`, with `retryable`/`requiresUserAction`/
`requiresReauth`/`requiresApproval` booleans and a `correlationId` that
matches the corresponding `AgentRunEvent`/audit-log entry. No raw provider
exception or stack trace is ever placed in `message`.

## 6. The research tools (`research/*`)

Two tools only, both `READ`, following Part 41's explicit "no
`research.execute`/`browse_anything`" prohibition:

- **`research.fetch(url)`** — `research/fetch.ts` calls the crawler's own
  `seo/fetch.ts` `fetchPage()` directly. This is the same SSRF/DNS
  -rebinding defense, redirect handling, and decompression caps the
  crawler uses for a tenant's own site — **zero new implementation** (Part
  42's explicit instruction: "do NOT create a second SSRF
  implementation"). `fetchPage` itself has no ownership requirement (the
  crawler layers ownership verification on top of it separately, for its
  own purpose); calling it here for an arbitrary public URL does not
  bypass anything. The result is a citation
  (`{ sourceUrl, title, retrievedAt, excerpt, excerptTruncated,
contentHash }`), not a raw page dump — extraction is
  `research/extract.ts`'s small cheerio-based readable-text function
  (deliberately much smaller than `seo/html.ts`'s SEO-specific
  `extractPage`, which the crawler needs and research does not).
- **`research.search(query)`** — `research/search.ts` has no configured
  provider. No search-API-key infrastructure exists in this deployment, so
  rather than build one with a fabricated or trial key, `searchProviderFromEnv()`
  returns `null` and the tool deterministically returns
  `{ available: false, reason: "No web search provider is configured…" }`
  — never invented results, following the `NullBillingGateway` convention
  and hard rule 1.

Both tools' output is untrusted external content; the caller (a future
model-facing prompt builder) is responsible for `wrapUntrusted()`-fencing
it, exactly like every other agent tool that returns third-party text —
neither tool builds a prompt itself.

## 7. Rate limiting, retry, and circuit-breaking — reused, not reinvented

- **Rate limiting**: `security/rate-limit.ts`'s existing fixed-window
  Redis limiter, keyed `tool-call:<org>:<toolName>`, fail-open on Redis
  outage (same convention as every other rate-limited surface).
- **Retry/timeout/circuit-breaking**: `integrations/resilience.ts`'s
  existing `resilientCall`/`CircuitBreaker`/`withRetry` composition, reused
  as-is for MCP connections (breaker keyed `mcp:<serverId>`, so one failing
  external server never throttles calls to a different one or to a
  different org's server of the same name). No second resilience
  implementation was written.
- **Usage metering**: a new `TOOL_CALLS` `UsageMeter` value, using the
  existing `checkUsage`/`recordUsage` idempotency pattern
  (`usage/record.ts`'s unique-constraint-based dedup), keyed
  `toolcall:<agentRunId|standalone>:<correlationId>`.

## 8. What Phase 5 deliberately did not build

Per the brief's own "do not overbuild" instructions and this project's
established scoping convention (see ADR-0055's Alternatives section for
the reasoning behind each):

- A generic dependency-graph orchestrator (sequential/parallel/
  conditional/compensation primitives) — no current caller needs one.
- A tool-result cache — no tool call is expensive enough yet to justify
  the invalidation complexity.
- A real web-search provider — no API key infrastructure exists.
- stdio MCP transport — a materially different security posture from an
  outbound HTTPS/SSE call; the data model reserves the value, nothing
  implements it.
- Wiring Capability Discovery / the Tool Executor / real tool-calling into
  the live growth-agent orchestrator's planner and turn loop — built,
  tested, not connected, exactly like Phase 4's `packages/ai` tool-calling
  support.
- A tool marketplace, tool versioning/deprecation lifecycle beyond
  metadata fields, and admin write actions on tool health — none of these
  have a real caller yet.
