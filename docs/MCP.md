# MCP.md — Model Context Protocol Integration (Phase 5)

Architecture reference for Growth Agent's MCP (Model Context Protocol)
client and server registry. See ADR-0055 for the design rationale and
`docs/PHASE-5-REPORT.md` for what was verified versus disclosed as
unverified.

## 1. What MCP is, here

MCP lets Growth Agent connect to a **third-party** server that exposes its
own tools over a small JSON-RPC protocol. Every MCP server is treated as
an untrusted third party by default (Part 28): its tools are disabled
until an admin reviews and enables them, its trust level starts at the
most restrictive value, and its output is handled exactly like any other
untrusted external content (crawled HTML, a WordPress post body, a video
caption) — data to analyze, never an instruction.

## 2. Protocol version, honestly

The installed `ai@4.3.19` package's MCP client
(`experimental_createMCPClient`) implements protocol version `2024-11-05`
— confirmed by reading its compiled source
(`LATEST_PROTOCOL_VERSION = "2024-11-05"`), not assumed from documentation.
This is **not** the "current specification" the Phase 5 brief refers to
(the brief describes a stateless core, cacheable discovery, and an
authorization/extensions framework consistent with a materially newer
draft than what ships in this SDK version). `packages/ai/src/mcp.ts`
documents this gap in its own header comment rather than silently
overstating compliance. A future phase that needs the newer protocol's
specific features (resumable sessions, the newer authorization framework,
server-initiated long-running tasks) will need either a newer `ai` SDK
release or a hand-rolled client — neither was attempted this phase.

## 3. Transport

The SDK ships one built-in transport config shape:
`{ type: 'sse', url, headers? }`. `McpTransportKind` in the database has
two values, `SSE` and `STDIO`; only `SSE` actually connects.
`STDIO` is a reserved value with an honest `McpError('unsupported_transport',
…)` — spawning an arbitrary local process from a web/worker request on
behalf of an organization is a materially different (and materially
riskier) security posture than an outbound HTTPS call, and this phase did
not attempt to design that safely. A custom `MCPTransport` object (a
`start`/`send`/`close` + `onmessage`/`onerror`/`onclose` implementation)
can be substituted for testing or for a future streamable-HTTP transport
without changing the registry or execution layer — that seam is exactly
how the test fixture (§7) plugs in.

## 4. Data model

Two additive tables, migration `20260924120000_tool_platform`:

- **`McpServer`** — one row per organization's connected server: `name`,
  `endpoint`, `transport`, `authKind` (`NONE`/`API_KEY`/`BEARER_TOKEN`), a
  sealed credential (`credentialCipher`/`Iv`/`AuthTag`/`keyId` — AES-256
  -GCM via the existing `crypto/tokens.ts`, exactly like a WordPress
  application password), `trustLevel`, `status`, `enabled`,
  `protocolVersion`/`serverVersion` (from the last successful handshake),
  and health fields (`lastError`/`lastCheckAt`/`lastCheckOk`).
- **`McpServerTool`** — one row per tool discovered from that server's
  `tools/list`: `name` (as the server calls it), `namespacedName`
  (`mcp.<server-slug>.<name>`), `description`, `inputSchema` (JSON,
  best-effort captured — see §6), `riskLevel`, and `enabled` (defaults
  `false`, always).

Both tables carry their own `organizationId` (denormalized off
`McpServer`, matching `WordPressContent`'s convention relative to
`WordPressSite`) so every query is directly tenant-scoped — verified by
`scripts/check-tenant-scope.mjs` and a dedicated
`mcp/tenant-isolation.integration.test.ts` (see §8 for its verification
status).

## 5. Trust levels and the double gate

`McpTrustLevel`: `INTERNAL` < `TRUSTED` < `VERIFIED_EXTERNAL` <
`UNVERIFIED_EXTERNAL` (ordered least-to-most-restrictive-by-default,
though nothing in the code enforces a linear order — trust level and risk
classification are independent lookups). A newly added server always
starts `UNVERIFIED_EXTERNAL`; only an explicit admin action
(`setMcpServerTrustLevelAction`) changes it — trust never auto-promotes.

Every MCP tool call must clear **two independent, explicit gates**, both
re-checked from the database on every single call (`getEnabledMcpToolByNamespacedName`
in `mcp/registry.ts`):

1. The **server** is `enabled`.
2. The **tool** itself is `enabled`.

Neither gate implies the other. Disabling the server does not need to also
disable every tool (they resume together when re-enabled, exactly as they
were configured); disabling one tool on an otherwise-enabled server leaves
the rest untouched.

## 6. Discovery (`mcp/discovery.ts`)

`syncMcpServerTools(organizationId, serverId)`:

1. Connects (via `mcp/client.ts`'s resilient wrapper — timeout, retry,
   circuit breaker, all reused from `integrations/resilience.ts`).
2. Calls `conn.tools()`, which internally does the real `initialize` →
   `notifications/initialized` → `tools/list` handshake.
3. For each discovered tool: rejects an empty or over-length name, rejects
   a duplicate name within the same response, namespaces it
   (`mcp.<slug>.<name>`), **rejects it outright if the namespaced name (or
   the raw name) collides with any reserved native/research prefix**
   (`integrations.`, `wordpress.`, `research.`, `youtube.`, `tiktok.`,
   `seo.`, `search_console.` — Part 32's explicit "never let an external
   server overwrite an internal tool name"), rejects a malformed or
   oversized (>50KB serialized) input schema, and classifies risk **from
   the server's trust level alone** — `UNVERIFIED_EXTERNAL` is always
   `CRITICAL`, `VERIFIED_EXTERNAL` is `HIGH`, `TRUSTED`/`INTERNAL` are
   `MEDIUM` (never `LOW` — that band is reserved for a tool this
   codebase's own audit has reviewed by hand). Risk is **never** guessed
   from the tool's own name or description, which a malicious server fully
   controls.
4. Upserts accepted tools, **preserving `enabled` across re-discovery** —
   an admin's prior enable/disable decision survives a server updating its
   tool catalog; only a genuinely new tool name gets the disabled default.
   `riskLevel` is likewise not silently overwritten on re-discovery of an
   existing tool (a behavior change on the server's side without a fresh
   admin review should not quietly reclassify a tool that was already
   approved).
5. Records the server's connection health (`recordMcpServerCheck`) either
   way — a failed discovery is a visible `ERROR` status with the
   (secret-scrubbed) failure reason, not a silent no-op.

**Schema capture is best-effort, not authoritative.** The SDK's `.tools()`
method returns AI-SDK-shaped `Tool` objects, not the raw JSON Schema; this
codebase extracts it defensively via the SDK's own `jsonSchema()` wrapper
convention (`.jsonSchema` property) for **display and audit purposes
only** — real argument validation for a live call happens inside the SDK's
own `execute()` path when a tool is genuinely invoked as an AI-SDK tool,
not by this codebase re-validating against the captured schema. A schema
that can't be introspected safely is stored as `null`, not fabricated.

## 7. Execution (`mcp/execute.ts`)

`executeMcpTool(organizationId, namespacedName, args)`:

1. Re-resolves the tool by namespaced name, re-checking both gates (§5) —
   never trusts a cached lookup or a model's claim that a tool is enabled
   (Part 88).
2. Runs it through `governance.decide(policy, 'MCP', 'analyze', …)` +
   `policy-engine.evaluateToolPolicy` — the org's MCP governance bucket
   (§ADR-0055 point 5) plus the server's live connection state.
3. Calls the tool via `mcp/client.ts`'s resilient `withMcpConnection`
   (opens, calls, always closes — even on a thrown error).
4. **Caps output at 20,000 characters** before it is returned or
   persisted — a hostile or buggy server's response size is bounded
   regardless of what it claims to return (Part 37).
5. Runs the result through `scrubModelOutput` (the same secret-redaction
   path every agent's model output already goes through) before returning
   it — an MCP server that echoes back something that looks like a token
   or API key is caught here, not just at the eventual model-output layer.
6. Returns a `ToolResultEnvelope` — never throws to the caller.

The server's own `isError: true` tool-level failure (a normal MCP result
shape, not a JSON-RPC protocol error) is passed through as `SUCCESS`
status with `data.isError = true` — the _call_ succeeded; the _tool_
reported its own failure, and the caller can distinguish the two.

## 8. Testing: what a "controlled test MCP server" means here (Part 114)

`packages/ai/src/mcp-fixture.ts` (`FixtureMcpTransport`) is a hand-rolled,
protocol-correct implementation of the exact JSON-RPC exchange the
installed SDK's client performs — reverse-engineered from that client's
own compiled source, not a mock of this codebase's own wrapper. It
supports the same tests a real external server would need to pass:
successful discovery, a failed handshake, a malformed `tools/list`
response (which the SDK's own schema validation correctly rejects
end-to-end, discovered live during test-writing — see §9), a slow/delayed
response, a tool that throws, and a tool that returns an oversized result.
`discovery.test.ts` and `mcp.test.ts` (in `packages/ai`) exercise the real
wire protocol against it.

**This is not the same thing as a live external MCP server.** No real
network MCP server was connected this phase — there is no such server
configured in this deployment, and none was available to test against
from this environment. The fixture proves the _protocol-handling code_ is
correct; it does not prove interoperability with any specific real-world
MCP implementation (Claude Desktop's reference servers, a third-party
SaaS's MCP endpoint, etc.), which would need genuine external
infrastructure this phase did not have access to.

## 9. A real finding from building the fixture

Writing `discovery.test.ts`'s original "malformed schema" test assumed a
single bad tool in a `tools/list` response would be skipped while sibling
tools were still discovered. Running it against the real SDK client
revealed this is wrong: the SDK's own `ListToolsResultSchema` Zod
validation parses the **entire** `tools/list` response as one unit, so one
tool with a non-object `inputSchema` fails the whole call before any
per-tool filtering in `discovery.ts` ever runs. This is actually _safer_
behavior than the original assumption (a malformed protocol response is
rejected wholesale, not partially trusted), and the test was corrected to
assert the real behavior: an oversized-but-well-formed schema is filtered
per-tool by `discovery.ts`'s own size cap (sibling tools still succeed); a
schema that fails the SDK's own base-type check fails the entire
discovery call (recorded as a connection error, nothing is silently
accepted).

## 10. Admin surfaces

- **Org-scoped**: `/app/integrations/mcp` — add a server, test the
  connection (runs discovery), toggle server/tool enablement, change trust
  level, remove a server. Mutations are Server Actions
  (`apps/web/src/server/mcp-actions.ts`), matching the existing
  WordPress/TikTok/YouTube connection-management convention — no separate
  `/api/integrations/mcp` REST surface was built (the brief's own
  suggested paths are adapted to this codebase's actual convention, per
  its own "adapt to existing routing conventions" instruction).
- **Cross-org, platform-staff-only, read-only**: `/admin/mcp-servers` —
  every MCP server across every organization, filterable by status/trust
  level, credential columns never selected. Follows the existing
  `/admin/integrations` pattern (`observability/admin-lists.ts`'s
  `listMcpServersAdmin`).

## 11. Security summary

- Credentials sealed at rest (AES-256-GCM), never returned to a client, a
  log line, or a tool result.
- Every discovered tool disabled by default; every newly connected server
  untrusted by default.
- Trust level never auto-promotes; risk classification is trust-level
  -derived, never model- or server-description-derived.
- A server can never claim a native tool's namespace.
- Both org-level MCP authorization (governance) and per-tool/per-server
  enablement are checked on every call — server-side, from the database,
  never from a cached value or a model's assertion.
- Output is untrusted, size-capped, and secret-scrubbed before it can
  reach anywhere else in the system.
- Rate-limited and circuit-broken per server, reusing existing
  infrastructure — no new resilience implementation.
