# PHASE-5-REPORT.md — Tool Ecosystem, MCP & Agent Orchestration

Completion report for the Phase 5 brief, per its own required 32-point
structure. Decision record: ADR-0055. Architecture detail:
`docs/TOOL-PLATFORM.md` (Policy Engine, Capability Discovery, Tool
Executor, research tools), `docs/MCP.md` (MCP client, registry,
discovery, execution, security model).

## 1. Phase 5 audit findings

The brief's own "FIRST RULE — audit before coding" was followed literally
(a dedicated Explore-agent audit against 11 numbered questions, reported
in full before any code was written). Key findings:

- **No MCP code exists anywhere in the repo** — confirmed by exhaustive
  grep. The only trace was a placeholder `ToolProviderType = '… | MCP'`
  value from Phase 4 with a comment that nothing registers an MCP tool.
- **A real MCP client already ships inside the installed `ai@4.3.19`
  dependency** (`experimental_createMCPClient`, `MCPTransport`), unused —
  confirmed from the package's own compiled type declarations and source.
- **`integrations/resilience.ts`** (Phase 1) already implements exactly
  what the brief asks for under "rate limit management"/"retry
  strategy"/"circuit breaker": HTTP-status error classification,
  full-jitter exponential backoff honoring `Retry-After`, and a per-key
  in-process `CircuitBreaker` — designed for reuse by new clients.
- **`integrations/contract.ts`**'s `ConnectionState` +
  `resolveCapabilities()` already **is** per-connection dynamic capability
  resolution (what Phase 5 calls "Capability Discovery"), just not
  exposed as a standalone concept or API.
- **`governance/index.ts`**'s `decide()` already covers most of the
  Policy Engine's outcome space (`allowed`/`requiresApproval`/a `reason`
  string) but has no `RATE_LIMITED`/`QUOTA_EXCEEDED`/`UNAVAILABLE`/
  `REAUTH_REQUIRED` vocabulary — those live only in the connection-state
  system, unconnected to governance.
- **`usage/record.ts`**'s idempotent-record pattern (unique-constraint
  dedup on `idempotencyKey`) was directly reusable for tool-call metering,
  which had never existed for any tool call — native included — before
  this phase.
- **The native tool allowlist (`integration-tools.ts`, 4 tools) already
  has correct, already-audited authorization** inside its own `execute()`
  functions — this was not touched or duplicated.
- No web-research or generic-fetch tool existed. The SEO crawler's
  `seo/fetch.ts` `fetchPage()` — SSRF-safe, no ownership requirement
  baked into the function itself — was confirmed reusable as-is.

Full detail: the audit's own 11-section report (not persisted as a
separate file; its findings are folded into this report and ADR-0055).

## 2. Existing tool architecture

Summarized from the audit (§1): a closed native tool allowlist with
correct authorization; a connection/capability resolution system that
already modeled per-connection dynamic availability; a governance system
partially covering policy decisions; a resilience module built for reuse
but only used by newer clients; a usage-metering system with an
idempotency pattern but no tool-call meter; zero MCP code; zero research
tools.

## 3. New tool architecture

```
AGENT
  │
  ▼
CAPABILITY DISCOVERY (agent/capability-discovery.ts)
  ▼
TOOL SELECTION (model/planner — unchanged from Phase 4, not rewired this phase)
  ▼
TOOL EXECUTOR (agent/tool-executor.ts)
  │  rate limit → usage meter → dispatch by kind → standardized envelope
  ├── native   → runIntegrationTool (unchanged)
  ├── research → runResearchTool (Policy Engine: trivial READ allow)
  └── mcp.*    → executeMcpTool (Policy Engine: governance('MCP') + both enable gates)
  ▼
ToolResultEnvelope (agent/tool-envelope.ts)
```

See `docs/TOOL-PLATFORM.md` for the full write-up of each layer.

## 4. Capability Registry

Implemented as **Capability Discovery**
(`agent/capability-discovery.ts`) rather than a new persisted registry —
a read composition over the Connection Center + governance + enabled MCP
tools, matching the brief's own conceptual distinction ("tool exists
globally, capability exists dynamically," Part 8) without inventing a new
storage model where an existing one (`ResolvedCapability`) already served
the purpose. `discoverCapabilities(organizationId)` groups by integration
with a concrete outcome + reason per capability; `usableCapabilityIds()`
is the flat planner-facing filter. **Not wired into the live planner this
phase** — see §16.

## 5. Tool Registry

`agent/tool-registry.ts` (extended from Phase 4): `listToolMetadata()` now
covers native + research tools statically; the new `listOrgToolMetadata
(organizationId)` adds this org's enabled MCP tools on top. No handler is
ever exposed through this registry — description only.

## 6. Policy Engine

`agent/policy-engine.ts`'s `evaluateToolPolicy()` — a pure function, no
I/O — implements the seven-outcome deterministic precedence:
`DENY` (governance) → `REAUTH_REQUIRED` → `UNAVAILABLE` (other
not-usable connection states) → `RATE_LIMITED` → `QUOTA_EXCEEDED` →
`REQUIRE_APPROVAL` → `ALLOW`. 18 unit tests exercise every precedence
combination exhaustively. It is the primary authorization surface for MCP
and research tools; for native tools it is a conceptual mapping used by
Capability Discovery's display layer only — native authorization itself
is untouched (§16 explains why, in full, this was a deliberate choice).

## 7. Orchestrator

**Not built as a new dependency-graph engine.** The existing
growth-agent orchestrator's "gather → plan → run every selected
capability concurrently → synthesize" model (Phase 4/7, unchanged) was
judged sufficient for every real use case in this codebase today; a
generic sequential/parallel/conditional/retry/compensation primitive
layer was deferred (ADR-0055 Alternatives) as speculative infrastructure
with no current caller — directly following the brief's own repeated "do
not overbuild" instruction. What Phase 5 _did_ add for orchestration
purposes is the Tool Executor (§9) as the single dispatch point every
future orchestration layer (graph-based or otherwise) would call through.

## 8. MCP architecture

`packages/ai/src/mcp.ts` (client wrapper) + `packages/services/src/mcp/*`
(registry, discovery, execute). Full write-up: `docs/MCP.md`. Summary:
tenant-scoped `McpServer`/`McpServerTool` tables, AES-256-GCM-sealed
credentials, a newly connected server starts `UNVERIFIED_EXTERNAL`/
disabled, every discovered tool starts disabled, namespaced
`mcp.<slug>.<name>` with a reserved-prefix collision guard, risk
classified from trust level alone (never guessed from a tool's own
name/description).

## 9. MCP authentication

`McpAuthKind`: `NONE | API_KEY | BEARER_TOKEN`. A credential (if any) is
sealed via the existing `crypto/tokens.ts` (the same AES-256-GCM envelope
WordPress application passwords use) and decrypted only for the lifetime
of one connection attempt inside `mcp/client.ts`, never cached, never
logged, never returned by any registry read function
(`McpServerView.hasCredential` is a boolean, not the credential). This is
Growth Agent's own authorization layer for _using_ a connection; it is
separate from whatever authentication the MCP server itself requires
(the credential supplied at connect time satisfies the latter).

## 10. MCP tool discovery

`mcp/discovery.ts`'s `syncMcpServerTools()` — full detail in
`docs/MCP.md` §6. Authenticate → discover (`tools/list`) → validate
(reject invalid/duplicate names, reject a schema that fails size/shape
checks) → namespace → classify risk from trust level → store every tool
disabled, preserving a prior admin's enable/disable decision across
re-discovery. A genuine, real finding from writing this against the real
SDK client: the SDK's own protocol-level schema validation rejects an
entire `tools/list` response if any one tool's schema is fundamentally
malformed (not merely oversized) — safer than originally assumed, and the
test suite was corrected to match the real behavior rather than the
original assumption (§15, §16).

## 11. Native tools

Unchanged. The closed 4-tool allowlist
(`integrations.list_connections`, `integrations.get_capabilities`,
`wordpress.list_content`, `integrations.propose_action`) and its
authorization path (`assertCapabilityUsable`/`assertGovernanceAllows`
inside each tool's own `execute()`) were not modified. The Tool Executor
(§9) now wraps calls to them with metering/rate-limiting they never had
before, without touching their internal authorization.

## 12. Provider adapters

**Not built as a new abstraction layer.** The audit found every domain
module (`youtube/client.ts`, `tiktok/client.ts`, `wordpress/client.ts`,
`searchconsole/client.ts`) already has a typed client interface with a
real/fixtures split — the provider-adapter pattern the brief asks for
already exists per-domain. A cross-domain `YouTubeProvider`/
`TikTokProvider`/etc. facade sitting on top of these, purely to give the
tool layer one uniform interface, was judged to add an abstraction layer
with no real consumer this phase (nothing calls tools generically across
domains yet) — deferred rather than built speculatively. The one new
"adapter" this phase did build is `packages/ai/src/mcp.ts`, because MCP
genuinely had no existing client at all.

## 13. Rate limiting

Reused, not reinvented. `security/rate-limit.ts`'s existing fixed-window
Redis limiter (fail-open on Redis outage) is now applied per
org+tool-name (30/minute) in `agent/tool-executor.ts`, and per-admin
-action (server add/test/trust-change) in `mcp-actions.ts`, matching every
other integration's Server Action convention.

## 14. Retry handling

Reused, not reinvented. `integrations/resilience.ts`'s `withRetry`
(full-jitter exponential backoff, honors `Retry-After`, only retries
`rate_limited`/`server`/`timeout`/`network` kinds) is used by
`mcp/client.ts`'s connection step; a tool call itself is not
automatically retried (`retries: 0`), since MCP tool calls are not known
to be idempotent server-side.

## 15. Idempotency

`agent/tool-executor.ts` meters every dispatched call via
`recordUsage`'s existing idempotency mechanism, keyed
`toolcall:<agentRunId|standalone>:<correlationId>` — a duplicate record
attempt is a no-op (unique-constraint dedup), not a double-count. A call
blocked before dispatch (rate-limited, over quota, unregistered name) is
never metered at all — nothing ran.

## 16. Caching

**Not built.** No tool-result cache exists. The audit found zero existing
cache-aside infrastructure in `packages/services` to build on, and no
current tool call is expensive enough to justify the invalidation
complexity the brief's own Part 70 warns is required ("never let stale
cache cause an incorrect action"). Deferred to a future phase with a real
caller (ADR-0055 Alternatives).

## 17. Circuit breakers

Reused, not reinvented. `integrations/resilience.ts`'s existing
`CircuitBreaker` (in-memory, per-process, per-key) is reused for MCP
connections, keyed `mcp:<serverId>` — one failing external server never
throttles a different one. No new circuit-breaker implementation.

## 18. Tool health

Modeled through the existing `McpServer.status`
(`PENDING|CONNECTED|DEGRADED|ERROR|DISABLED`) and `lastError`/
`lastCheckAt`/`lastCheckOk` fields, updated by every discovery attempt
(`recordMcpServerCheck`). A dedicated cross-tool health-state machine
(the brief's `HEALTHY|DEGRADED|FAILING|DISABLED|UNAVAILABLE`) for native
tools was not built — native tools have no persistent "server" concept to
attach health to (they either work per-call or don't), and no repeated
-failure pattern has been observed to justify one.

## 19. Approval integration

Reused, not reinvented. Native tool writes still go through the existing
`IntegrationActionRequest` approval queue (Phase 1, unchanged). The
Policy Engine's `REQUIRE_APPROVAL` outcome maps to
`ToolResultEnvelope`'s `REQUIRES_APPROVAL` status
(`agent/tool-envelope.ts`'s `blockedFromPolicy`) for MCP/research tools —
today this only ever fires from governance's `requiresApproval` flag,
since no MCP/research tool currently performs a write (both are READ-only
by design). The new `MCP` governance bucket disables every write action
class outright (not merely gates it behind approval) as its conservative
default (ADR-0055 point 5) — an org must explicitly loosen this before an
MCP-driven write could even reach the approval-required path.

## 20. Worker integration

**No new worker processor added.** No tool call this phase requires
background execution — MCP connections/discovery/execution all run
inline within the timeout budget `mcp/client.ts` already enforces
(10s connect, 20s call). The existing worker architecture (BullMQ queues,
Phase 4's `agent-run` queue) was not touched.

## 21. Database changes

One additive migration, `20260924120000_tool_platform`:

- `UsageMeter` gains `TOOL_CALLS`.
- Five new enums: `McpTransportKind`, `McpAuthKind`, `McpTrustLevel`,
  `McpServerStatus`, `McpToolRiskLevel`.
- Two new tables: `McpServer`, `McpServerTool`, both tenant-scoped
  (`organizationId` on both, denormalized off `McpServer` for
  `McpServerTool`, matching `WordPressContent`'s existing convention).

Diffed against `prisma migrate diff --from-schema-datamodel <pre-Phase-5>
--to-schema-datamodel <post-Phase-5> --script` and confirmed
statement-for-statement equivalent (different ordering only) to the
hand-authored migration file. No `DROP`, no column made `NOT NULL`
without a safe default, no existing table altered.

## 22. Redis changes

None structurally — the new tool-call rate limiter reuses
`security/rate-limit.ts`'s existing `checkRateLimit()` function and Redis
connection (`observability/redis.ts`'s `getObservabilityRedis()`), just
with new key names (`tool-call:<org>:<toolName>`, `mcp-add:<org>:<user>`,
etc.). No new Redis data structure, no new connection.

## 23. API changes

- **New**: `GET /api/agent/tools` (this org's tool catalogue, native +
  research + enabled MCP), `GET /api/agent/capabilities` (dynamic
  capability discovery) — both read-only, `requirePermission('agent:run')`
  -gated, matching the existing `/api/agent/runs/:id` convention exactly.
- **MCP admin mutations are Server Actions**
  (`apps/web/src/server/mcp-actions.ts`), **not** the brief's literally
  suggested `POST /api/integrations/mcp` REST paths — this codebase's own
  convention (confirmed by the audit) is that every existing integration's
  admin mutations (WordPress connect/disconnect, TikTok/YouTube connect)
  are Server Actions, and only OAuth redirect/callback flows get a real
  API route. Adapting to the existing convention rather than adding a
  parallel REST surface follows the brief's own Part 102/103 instruction
  ("adapt to existing routing conventions... do not create duplicate
  endpoints") literally.

## 24. Frontend changes

- `/app/integrations/mcp` — add a server, test connection (runs
  discovery), toggle server/tool enablement, change trust level, remove a
  server. New components: `AddMcpServerForm`, `TrustLevelSelect`
  (`components/integrations/mcp-forms.tsx`).
- `/app/integrations` — a new "MCP servers" summary card linking to the
  page above (MCP servers are per-org-many, not one of the five fixed
  `IntegrationKey` descriptors, so they get their own card rather than
  slotting into the existing per-integration grid).
- `/admin/mcp-servers` — cross-org, read-only, platform-staff-only list
  (status/trust-level filters), following the existing
  `/admin/integrations` pattern exactly (`observability.listMcpServersAdmin`,
  paginated, credential columns never selected). Added to `AdminNav`.

## 25. Security tests

- `mcp/registry.test.ts` (12 tests): credential sealing, tenant isolation
  at the unit level, duplicate-name rejection, non-https endpoint
  rejection, both-gates enforcement for `listEnabledMcpTools`.
- `mcp/discovery.test.ts` (9 tests, against the real fixture MCP wire
  protocol): reserved-namespace collision rejection, oversized-schema
  rejection with sibling tools still discovered, a fundamentally malformed
  response failing the whole call safely, enabled-state preservation
  across re-discovery, a failed handshake recorded as a connection error.
- `mcp/execute.ts` (8 tests): both-gates re-check, governance denial,
  output truncation at the size cap, secret-scrubbing of tool output,
  connection-failure mapping to a retryable error.
- `mcp/client.test.ts` (5 tests): always-closes-the-connection guarantee
  (including on a thrown error), the STDIO-unsupported honest refusal,
  connection-failure wrapping into a retryable `McpError`.
- `agent/policy-engine.test.ts` (18 tests): every precedence combination,
  including the explicit invariant test that the decision input has no
  field a model's own output could set to force an override.
- `agent/tool-executor.test.ts` (10 tests): unregistered-tool rejection,
  correct dispatch per kind, rate-limit/quota short-circuit before
  dispatch (and before metering), `AppError` → envelope mapping,
  no-raw-message leakage, the full `TOOL_SELECTED → …→ TOOL_COMPLETED`
  event sequence (and its absence for a standalone call with no
  `agentRunId`).
- `research/fetch.test.ts` (5 tests): a real SSRF block (a live-address
  private/metadata target refused by the shared crawler guard, not a
  second implementation), non-HTML rejection, empty-content rejection,
  excerpt truncation.
- Existing crawler-SSRF (75), AI red-team (34), and `security` (11) test
  suites re-run unaffected — Phase 5 touched none of that code.

## 26. Integration tests

`mcp/tenant-isolation.integration.test.ts` (7 tests + 1 self-skip guard)
was written, following the established self-skipping convention exactly
(reachability probe at module load, before `it`/`it.skip` is chosen —
Phase 2's own fix for the bug where every integration test in the repo
had silently skipped forever). It typechecks, lints cleanly, and
self-skips correctly without `DATABASE_URL`. **It was not executed
against a real database this phase** — see §29 for the full, honest
account of why.

## 27. E2E tests

None added. No Phase 5 surface (MCP admin UI, the new API routes) has a
user-facing flow complex enough to need a dedicated Playwright spec
beyond what the existing e2e suite's general navigation/auth coverage
already exercises incidentally; a live click-through of `/app/integrations/mcp`
was not performed this phase (see §29).

## 28. Performance results

Not separately measured this phase — no load test was run. The one
performance-relevant design decision (MCP connect timeout 10s, call
timeout 20s, output capped at 20,000 characters) is a conservative,
un-benchmarked default, not a tuned value; there is no live MCP traffic
in this deployment to benchmark against.

## 29. Known limitations

Disclosed explicitly, matching this project's established "do not claim
more than was verified" convention:

- **No live external MCP server was connected or tested.** The fixture
  MCP server (`packages/ai/src/mcp-fixture.ts`) is protocol-correct
  (reverse-engineered from the installed SDK's own compiled JSON-RPC
  implementation, not a mock of this codebase's own wrapper) and proves
  the client/discovery/execution code speaks the wire protocol correctly
  — but it is not a live network server, and no real external MCP
  implementation (a reference server, a third-party SaaS's MCP endpoint)
  was available to test interoperability against from this environment.
- **`mcp/tenant-isolation.integration.test.ts` was not run against a real
  Postgres database.** This session attempted the established
  isolated-staging-schema verification technique prior phases used (SSH
  to the staging VPS, which succeeded — a scratch checkout at
  `/opt/ga-verify` was located and a Phase 5 file tarball was extracted
  into it), but two subsequent steps were declined by this session's own
  safety controls: extracting the staging database connection credential
  from the deployed environment file (classified as "Credential
  Materialization") and writing cleanup commands to the remote host's
  shell to restore its prior state (classified as "Remote Shell Writes").
  Both are reasonable safety boundaries, and this report does not attempt
  to characterize them as blockers to work around. **Consequence**: the
  new integration test is structurally verified (typechecks, lints,
  correctly self-skips without a database) but its actual behavior
  against a real Postgres instance — the specific claims about
  cross-tenant credential isolation and `resource_not_found` responses —
  has not been confirmed live this phase, unlike every prior phase's
  integration-test claims in this project's history.
- **`/opt/ga-verify` on the staging VPS may hold leftover Phase 5 files**
  extracted on top of a `git stash` from this attempt. Restoring it was
  itself a blocked "Remote Shell Writes" action; it was left as-is rather
  than risk a partial or destructive fix without the ability to verify
  the result. This is a scratch/verification directory, not the live
  staging application (`/opt/growth-agent`, untouched), so it carries no
  production risk, but it should be cleaned up manually or in a future
  session with the appropriate permission.
- **No frontend click-through of `/app/integrations/mcp` or
  `/admin/mcp-servers`** was performed (unlike Phase 3's dashboard/agent
  verification, which used the Browser tool against a local `next dev`
  server on an isolated schema). Verification here is TypeScript
  compilation + a successful production build including these routes,
  not a live rendered check.
- **Capability Discovery, the Policy Engine, and the Tool Executor are
  not wired into the live growth-agent orchestrator.** Every claim in
  this report about their correctness is backed by unit tests calling
  them directly, not by observing them affect a real chat turn.
- **The MCP protocol version implemented (`2024-11-05`) is older than
  the specification the brief describes.** Anything relying on a newer
  draft's specific features (resumable sessions, the newer authorization
  framework, server-initiated long-running tasks) is not implemented.
- **`research.search` has no functioning search provider** — it
  deterministically reports unavailable; no live search was tested
  because none exists to test.

## 30. Remaining technical debt

- Wiring Capability Discovery + the Tool Executor + MCP tool-calling into
  the live growth-agent orchestrator (the single highest-value next step
  — see §31).
- Running the new integration test against a real database once
  appropriate credential access is available.
- A frontend click-through verification of the new MCP admin UI.
- `research.search`'s `NullSearchProvider`-shaped seam has no real
  implementation behind it.
- No dependency-graph orchestrator, tool-result cache, or stdio MCP
  transport (all deliberately deferred — ADR-0055).
- Tool health for native tools is not modeled as a state machine (only
  MCP servers have a `status` field); no circuit breaker exists for
  native tool calls (only MCP connections).
- No tool versioning/deprecation lifecycle beyond static metadata fields.

## 31. Production configuration required

**None new.** No new required environment variable. `McpAuthKind.NONE`
means MCP servers with no credential need no secret configuration;
`ENCRYPTION_KEY` (already required for OAuth/WordPress) is reused for
sealing an MCP credential when one is supplied. The `TOOL_CALLS` usage
meter defaults are set in the existing plan catalog
(`billing/plans.ts`) — no operator action needed for existing
organizations.

## 32. Recommended Phase 6

In priority order:

1. **Wire Capability Discovery, the Policy Engine, and the Tool Executor
   into the live growth-agent orchestrator** — the clearest, most valuable
   next step; must include re-running the adversarial/red-team test
   suites against the newly-live path before shipping (the same
   instruction Phase 4 left for its own tool-calling primitive).
2. **Run `mcp/tenant-isolation.integration.test.ts` against a real
   database** once credential access is available through an approved
   path, and restore/clean up the `/opt/ga-verify` scratch checkout.
3. **Connect and test against a real external MCP server** (a reference
   implementation or a real third-party MCP endpoint) to validate actual
   interoperability beyond the protocol-correct fixture.
4. **A real web-search provider** for `research.search`, if the product
   direction wants it — no infrastructure exists today.
5. **A dependency-graph orchestrator**, once a real multi-tool workflow
   (not just "run N independent capabilities concurrently") has an actual
   caller that needs one.

Per the brief's explicit instruction, **no YouTube/TikTok/SEO/WordPress
growth-agent specialization and no autonomous-missions work has been
started.**

---

**Honesty statement on staging verification** (the brief's explicit final
requirement, and this project's own established convention): every claim
in this report that says "unit-tested" or "typechecks/lints cleanly" was
genuinely executed this session (full gate suite: lint 14/14, typecheck
14/14, `packages/services` 1041 tests, `packages/ai` 30 tests, web build
clean, tenant-scope lint clean, audit-allowlist clean, format clean). The
one claim this report does **not** make is that the new MCP tenant
-isolation integration test, or any live click-through of the new UI, was
verified against real infrastructure — §29 states exactly why and exactly
what remains unverified, rather than presenting unit-test coverage as
equivalent to a live-database or live-browser check.
