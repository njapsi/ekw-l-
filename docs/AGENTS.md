# AGENTS.md

## Rule

Do **not** build one giant autonomous agent. Build specialized agents with
narrow tool sets, coordinated by an orchestration layer.

## Agents

| Agent id                                            | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `growth-agent`                                      | **Unified AI Growth Agent (implemented, Phase 7).** Conversational at `/app/agent`. Plans which specialists to run, executes them, collects evidence, and returns a grounded structured answer + tasks. Never changes an external account.                                                                                                                                                                                                                                                              |
| `growth-analyst`                                    | Cross-surface synthesis; turns findings into a plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `youtube-analyst`                                   | Channel/video/title/description/topic/schedule analysis.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tiktok-analyst`                                    | Profile/video analysis within official API limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `seo-crawler`                                       | Fetches and renders pages, extracts machine-readable data.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `seo-technical-auditor`                             | Evaluates crawl data against technical-SEO rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `seo-auditor`                                       | Grounded plain-language crawl summary → `Recommendation`s (implemented).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `seo-agent`                                         | AI SEO Agent: reasons over stored crawl data via restricted read-only `seo.*` tools, ranks fixes, builds action plans, answers questions, scores machine readability (implemented).                                                                                                                                                                                                                                                                                                                     |
| `content-strategy`                                  | Content ideas, gaps, repurposing, calendars.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `content-analyst` / `content-generator`             | **Content repurposing engine (implemented, operator's "Phase 8").** `content-analyst` produces the grounded `ContentAnalysis` (key ideas + angles); `content-generator` produces the 13 platform deliverables. The engine never publishes. See `docs/CONTENT-REPURPOSING.md`.                                                                                                                                                                                                                           |
| `monetization-opportunity` / `monetization-analyst` | **Monetization intelligence (implemented, operator's "Phase 9").** A deterministic engine builds one opportunity per applicable channel (11 channels) with the seven required fields + a priority score; `monetization-analyst` optionally refines the prose, grounded, and is dropped on any grounding failure. Estimates are labels, never dollar amounts. PLATFORM_MONETIZATION never claims the creator qualifies — the platform decides. Revenue is user-entered only. See `docs/MONETIZATION.md`. |
| `recommendation`                                    | Normalizes findings into `Recommendation` objects.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `reporting`                                         | Assembles `AnalysisReport`s and exportable reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Contracts (`packages/core`)

- `Agent<TInput, TOutput>` — `id`, `allowedTools`, `run(task)`.
- `AgentTask<TInput>` — `id`, `agent`, `input`, `tenant: TenantContext`.
- `Orchestrator` — `route(request, tenant)` picks an agent id;
  `dispatch(task)` runs it and returns `Result<TOutput, AgentError>`.

## The AI SEO Agent's tools (implemented, Phase 6)

`packages/services/src/seo/agent-tools.ts` defines a **closed allowlist** of nine
read-only tools — `seo.get_project`, `seo.get_crawl`, `seo.get_page`,
`seo.get_issues`, `seo.get_internal_links`, `seo.get_sitemap`, `seo.get_robots`,
`seo.get_schema`, `seo.get_site_architecture`. There is **no write tool**: the
agent cannot modify a production website, by construction. Every tool is scoped
by `organizationId` from the tenant context (never from tool input), validates
its input with Zod, and returns plain data. `executeSeoTool(name, input, ctx)` is
the only entrypoint and rejects any name not on the list. The agent does not
crawl — it reasons over data a crawl already produced. Each tool call is recorded
on the `AgentRun` output.

## The Unified AI Growth Agent (implemented, Phase 7)

`packages/services/src/agent` — one conversational agent at `/app/agent`.

- **Capability registry** (`capabilities.ts`): the central agent selects from a
  fixed set of tenant-scoped wrappers — `org-context` (always first),
  `youtube-analyst`, `youtube-monetization`, `tiktok-analyst`, `seo-agent`,
  `content-repurpose`, `growth-plan`. Each returns `{ summary, evidence[],
recommendations[] }`. A missing prerequisite yields `needs_prerequisite`, not
  a failure. Max 5 per turn.
- **Planning** (`planner.ts`): a deterministic keyword router always produces a
  plan; a model refines the selection and writes a one-line rationale. It never
  invents a capability.
- **Grounded synthesis** (`orchestrator.ts`): `generateObject` →
  `GrowthAgentResponse` (analysis summary · evidence · decisions ·
  recommendations · proposed actions), checked with the shared grounding guard.
  On failure the model output is dropped and the capability results are
  assembled deterministically. **No chain-of-thought is exposed** — the schema
  has no `thinking` field; `decisions` is one line per capability used.
- **Streaming**: SSE from `/api/agent/stream` — `status`, `token`, `done`
  events; the turn (conversation + messages + `AgentRun`) is persisted as it
  runs.
- **Memory**: see AI-ARCHITECTURE.md §5 — six `OrgMemory` kinds, allowlisted and
  secret-redacted at write time.
- **Actions → tasks**: a recommendation becomes a `Task` (Title / Priority /
  Affected URLs / Instructions / Status). **External-system actions are proposed
  with `requiresConfirmation` and never executed by the orchestrator** — they go
  through the owning feature's approval screen (ADR-0022).

## Safety constraints

- Agents receive a `TenantContext`, never a raw DB client. Data access is via
  tenant-scoped repository functions passed as tools.
- `allowedTools` is explicit per agent; the orchestrator rejects a tool call
  outside the list.
- No destructive or external-mutating action without an approved
  `Recommendation` (or automation mode explicitly enabled by the user).
- Crawled/external content is untrusted: it can never alter tool authorization,
  tenant scope, or approval state (prompt-injection defense).
- Every run is recorded as an `AgentRun` (input, output, status, timing).

## Restricted tools — verification (Phase 22)

Audited every agent for tool surface and write paths:

| Agent                                                                                                                          | Tool surface                                                                                                                                                                                                                                                               | Write path?                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `seo-agent`                                                                                                                    | closed allowlist of 9 read-only `seo.*` tools (`executeSeoTool` rejects any name off the list, validates input with Zod) + 6 read-only `gsc.*` tools (`bindGscAgentTools`, each returns `{available:false}` rather than fabricate); org comes from `ctx`, never tool input | **none**                                                                                        |
| `growth-agent`                                                                                                                 | fixed capability registry (`org-context`, `youtube-analyst`, `youtube-monetization`, `tiktok-analyst`, `seo-agent`, `content-repurpose`, `growth-plan`); max 5/turn; each tenant-scoped                                                                                    | **none** — external actions are proposed with `requiresConfirmation`, never executed (ADR-0022) |
| `youtube-analyst`, `tiktok-analyst`, `monetization-analyst`, `content-analyst`/`content-generator`, `seo-auditor`, `reporting` | **no tool loop** — one `generateObject(schema)` call against a deterministic fact sheet; the model only refines prose                                                                                                                                                      | **none** — the model never receives a callable tool                                             |

No agent anywhere holds a raw Prisma client, a write tool, an HTTP fetch, or a
publish/delete capability. `content` publishing and `tiktok` publishing run
through their own feature's explicit-approval Server Action, not an agent.
`packages/services/src/agents/adversarial.test.ts` asserts `executeSeoTool`
rejects `seo.delete_site` / `seo.update_page` / an injected `DROP TABLE` name and
that a foreign `organizationId` in tool input is ignored.

**Tool-calling is not model-driven anywhere in this codebase** (verified
Phase 25, `docs/AI-SECURITY-AUDIT.md`): `generateWithTools` — the AI SDK's
native tool-calling loop, where a model decides at runtime which tool to
invoke and with what arguments — remains "planned, not implemented." Every
`seo.*`/`gsc.*` call above is made by **our own code**, before any prompt is
built, to assemble a fact sheet; the model only ever returns a
schema-validated JSON object at the end. This is the structural reason "tool
manipulation" isn't a live attack surface today — there is no runtime
function-calling decision for an injection to redirect. If a future phase
adds real model-driven tool-calling, this section and the "tool manipulation"
row in `docs/AI-SECURITY-AUDIT.md` must be revisited together.

## Untrusted-content fencing (Phase 22, extended Phase 25)

Every model prompt that carries external or user text fences it with
`wrapUntrusted(label, text)` and its system prompt carries
`UNTRUSTED_CONTENT_SYSTEM_CLAUSE`. See `docs/AI-ARCHITECTURE.md` §5 for the label
map. Phase 25 (`docs/AI-SECURITY-AUDIT.md`, ADR-0040) extended that clause to
state the SYSTEM/DEVELOPER > USER > EXTERNAL DATA trust hierarchy by name and
forbid system-prompt disclosure and authority-elevation claims, and added two
code-level backstops that don't depend on the model honoring the clause:
output-side secret scrubbing (`agents/output-scrub.ts`) and a forced
`requiresConfirmation: true` invariant on external proposed actions
(`agent/orchestrator.ts`'s `finalizeBlocks`). Adversarial coverage:
`packages/services/src/agents/ai-red-team.test.ts`.
