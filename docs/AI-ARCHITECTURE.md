# AI-ARCHITECTURE.md

Two layers:

1. **Model abstraction** (`packages/ai`) — provider-agnostic access to models.
2. **Agent orchestration** (`packages/services/ai`) — specialized agents, a
   tool registry, an orchestrator, memory/context, and safety controls.

Non-negotiables (master instruction D, I, J, K):

- No provider is hard-coded into the app. Providers/models are swappable.
- Not one giant autonomous agent — many narrow agents + an orchestrator.
- Agents get **restricted tools**, never a raw DB handle, never destructive
  actions without approval.
- Outputs are **structured** (Zod schemas) wherever possible.
- Every statement is tagged `fact | calculated_metric | assumption | prediction
| recommendation` with evidence. Missing data is reported, never invented.

---

## 1. Model abstraction (`packages/ai`)

### Interface (`AIProvider`)

| Capability            | Method                                              | Status                                                                                          |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Text generation       | `generateText`                                      | shipped (Phase 0)                                                                               |
| Structured JSON       | `generateObject(schema)`                            | shipped                                                                                         |
| Streaming text        | `streamText`                                        | shipped                                                                                         |
| Embeddings            | `embed` (optional)                                  | interface present                                                                               |
| **Tool calling**      | `generateText({ tools, maxSteps })`                 | **shipped (Phase 4)** — real, tested, not yet called by any live orchestrator capability        |
| Model selection       | `ModelRef { provider, model }` per call             | shipped                                                                                         |
| **Model roles**       | `getForRole('analyst'\|'router'\|…)`                | shipped (Phase 22)                                                                              |
| Usage + cost          | `UsageRecord` from every call                       | shipped; wired into every growth-agent turn's model calls, not just the final one (Phase 4 fix) |
| **Timeout**           | `AI_REQUEST_TIMEOUT_MS` per call (`withResilience`) | shipped (Phase 22)                                                                              |
| **Retry**             | `AI_MAX_RETRIES` (429/5xx/network, SDK)             | shipped (Phase 22)                                                                              |
| **Provider fallback** | `AI_FALLBACK_MODELS` chain (`FallbackProvider`)     | shipped (Phase 22)                                                                              |
| **Kill switch**       | `AI_DISABLED` / `AI_DISABLED_PROVIDERS`             | shipped (Phase 22)                                                                              |

**Tool-calling (Phase 4).** `GenerateTextOptions` now accepts `tools:
ToolDefinition[]` and `maxSteps`; `VercelAIProvider.generateText` maps them
to the Vercel AI SDK's own multi-step tool-calling loop and returns
`toolCalls`/`steps` on the result (`packages/ai/src/providers/vercel.ts`,
tested in the sibling `.test.ts`). The growth-agent orchestrator's
capabilities still make their own direct function calls rather than
offering the model a tool list — see `docs/AGENT-RUNTIME.md` §6 for the
full reasoning and `docs/AGENTS.md` for the current, precise "nothing live
uses this yet" statement.

### Resilience (Phase 22)

`createRegistryFromEnv()` wraps **every** registered provider in
`withResilience` (`packages/ai/src/resilient.ts`): a per-call deadline
(`opts.timeoutMs` → `AI_REQUEST_TIMEOUT_MS` → 60 s) enforced with an
`AbortController`, one retry of a timed-out call, and a kill switch checked per
call (`AI_DISABLED` disables the layer; `AI_DISABLED_PROVIDERS` disables one
provider) that throws `AiDisabledError` before any network call. Transient
429/5xx/network retries are configured once (`AI_MAX_RETRIES`, default 2) and
handled by the provider SDK so the two layers never compound.

`AI_FALLBACK_MODELS` (`"openai:gpt-4o-mini,google:gemini-2.0-flash"`) builds a
`FallbackProvider` (`packages/ai/src/fallback.ts`): `registry.get()` /
`getForRole()` returns a chain — head = the requested model, tail = every
configured fallback whose provider has a key. A thrown error advances to the
next entry; total failure throws `AiAllProvidersFailedError`; a whole-layer
`AiDisabledError` is surfaced, not swallowed. Call sites are unchanged —
`registry.get().provider.generateObject(...)` transparently gains all of the
above. `streamText` only falls back on the initial connection failure. Every
analyst additionally has a deterministic fallback, so a total AI outage degrades
to reduced insight, never an error to the user.

### Registry

`ProviderRegistry` registers concrete providers (`anthropicProvider`,
`openaiProvider`, `googleProvider` — thin factories over the Vercel AI SDK),
resolves the model for a call (default from `AI_DEFAULT_PROVIDER` /
`AI_DEFAULT_MODEL`, overridable per call), and fans `UsageRecord`s to
`UsageSink`s. `createRegistryFromEnv()` wires whichever providers have keys.

### Model roles (logical → concrete, configurable)

| Role           | Default                        | Used for                                               |
| -------------- | ------------------------------ | ------------------------------------------------------ |
| `router`       | small/cheap (e.g. Haiku-class) | orchestrator routing, classification, cheap extraction |
| `analyst`      | mid (e.g. Sonnet-class)        | analysis, synthesis, recommendation drafting           |
| `long_context` | large-context model            | whole-crawl / long-history reasoning                   |
| `embedding`    | `text-embedding-3-small`-class | semantic search over findings/history                  |

Call sites ask for a **role**; a config map resolves role → `ModelRef`. Swapping
a model is a config change.

**Implemented (Phase 22)** — `packages/ai/src/roles.ts` `modelForRole(role)`:
`AI_MODEL_<ROLE>` env (`"provider:model"`) → else a per-role default keyed off
the default provider → else `AI_DEFAULT_*`. `registry.getForRole('analyst')` is
the accessor. The analyst job factories
(`{seo,youtube,tiktok,content,monetization,reports}/jobs.ts`, `agent/jobs.ts`)
resolve the `analyst` role; behaviour is identical to before when no
`AI_MODEL_*` is set.

### Pricing, usage, cost

`pricing.ts` holds a per-model price table → `estimatedCostUsd`. Unknown model =
cost `0` **and a flag** the caller must surface (never silently zero). Every call
produces a `UsageRecord`.

**Metering (Phase 10, implemented).** The `usage` module records AI use into the
billing meters `AI_REQUESTS` (+1 per model call / agent run) and `AI_TOKENS`
(+prompt+completion). Two paths: `usage.createAiUsageSink(orgId)` is an
`@growth-agent/ai` `UsageSink` for call sites that thread a live sink into the
registry; `usage.recordAgentRunUsage(orgId, agentRunId)` reads the finished
`AgentRun`'s token counts and is called from the job / route layer (agent-stream
route, `runGrowthAgentTurnJob`, `runMonetizationScanJob`; the same one-liner
extends to the other analyst jobs). Both are **idempotent** on the run/context
id. Per-org **budget guard**: `usage.enforceUsage({ org, meter: 'AI_REQUESTS' })`
runs **server-side** before a turn (429 `usage_limit_exceeded` with an upgrade
path when over) — the browser is never trusted. See `docs/BILLING.md`.

**Per-user throttle (Phase 22).** `usage.enforceAiUserLimit({ organizationId,
userId, scope })` sits in front of that per-org monthly cap: a fixed-window
Redis limiter (`AI_USER_RATE_LIMIT` / `AI_USER_RATE_WINDOW_SEC`, default 30/60 s,
per `(org, user, scope)`), **fail-open** so a Redis outage never blocks a paying
user. It is wired into the agent-stream route and the SEO-agent / content /
monetization / YouTube / TikTok analyst Server Actions. It is a rate limit, not
a billing meter — the hard cap stays with `enforceUsage`.

---

## 2. Agents

Each agent implements `Agent<TInput, TOutput>` from `packages/core`:
`id`, `allowedTools` (explicit allowlist), `run(task)` → `Result<TOutput,
AgentError>`. Agents receive an `AgentContext`, never Prisma.

| Agent                        | Job                                                                        | Typical tools (allowlist)                                                            | Output schema                                           |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **growth-analyst**           | Cross-surface synthesis; owns the user-facing plan                         | `read_metrics`, `read_seo_findings`, `read_history`, `search_findings`, `call_agent` | `AnalysisReport`                                        |
| **youtube-analyst**          | Channel/video/title/description/topic/cadence analysis                     | `read_youtube_channel`, `read_youtube_videos`, `read_youtube_metrics`                | `Finding[]`                                             |
| **tiktok-analyst**           | Profile/video/posting analysis within API limits                           | `read_tiktok_account`, `read_tiktok_videos`, `read_tiktok_metrics`                   | `Finding[]`                                             |
| **seo-crawler**              | Turn a crawl request into a bounded crawl plan; interpret raw crawl output | `get_crawl`, `get_crawl_pages`, `enqueue_crawl` (bounded, approval per policy)       | `CrawlInterpretation`                                   |
| **seo-technical-auditor**    | Evaluate crawl data against technical-SEO rules                            | `get_crawl_pages`, `get_link_graph`, `rule_lookup`                                   | `CrawlIssue[]`                                          |
| **content-strategy**         | Ideas, gaps, repurposing                                                   | `read_catalogue`, `read_seo_findings`, `search_web_public` (ToS-limited)             | `ContentIdea[]`                                         |
| **monetization-opportunity** | Identify + rank monetization opportunities; readiness estimate             | `read_youtube_metrics`, `read_program_thresholds`, `read_history`                    | `Finding[]` (+ readiness estimate, labelled prediction) |
| **recommendation**           | Normalize findings → `Recommendation` objects                              | `read_findings`, `dedupe_recommendations`                                            | `Recommendation[]`                                      |
| **reporting**                | Assemble `AnalysisReport` + exportable report                              | `read_recommendations`, `read_metrics`, `render_report`                              | `Report` payload                                        |

The orchestrator is not itself an "agent" with tools; it is a coordinator (§3).

---

## 3. Orchestration

### Implemented: the Unified AI Growth Agent (Phase 7)

`packages/services/src/agent` — one conversational agent at `/app/agent` that
reasons across YouTube, TikTok and SEO. Per turn (`orchestrator.ts`
`streamGrowthAgentTurn`, a Server-Sent-Events stream):

1. **Gather** — `loadOrgContext` (what is connected + freshest data, read-only)
   and `loadMemory` (goals / preferences / recent recs / completed tasks).
2. **Plan** — `planner.ts`: a deterministic keyword router always yields a plan;
   with a model, `generateObject` refines the capability selection and writes a
   **one-line** routing rationale (never step-by-step reasoning). `org-context`
   always runs first regardless of the plan.
3. **Execute** — the selected **capabilities** run (`capabilities.ts`). Each is a
   thin, tenant-scoped wrapper over an existing specialist
   (`youtube-analyst`, `youtube-monetization`, `tiktok-analyst`, `seo-agent`,
   `content-repurpose`, `growth-plan`). A capability with a missing prerequisite
   returns `needs_prerequisite` instead of failing. Max 5 per turn; each is
   isolated in try/catch. The registry is overridable via `deps.capabilities`.
4. **Collect evidence** — every capability returns `{ summary, evidence[],
recommendations[] }`; evidence items are id-tagged (`e1`, `e2`, …).
5. **Synthesize** — `generateObject` against the `GrowthAgentResponse` schema,
   grounded via the shared `checkGroundingFields` (cite `evidenceRefs`, no
   invented numbers, no guarantees). One repair; if it still fails, the model
   output is **dropped** and a deterministic assembly of the capability results
   is used — the numbers/recommendations never depend on the model.
6. **Generate response** — `streamText` writes the natural-language reply from
   the structured blocks; without a model a deterministic markdown reply is
   streamed in chunks.
7. **Persist** — `AIConversation` + two `AIMessage`s (the assistant message
   carries the `blocks`) + an `AgentRun` (`agent: 'growth-agent'`). Then
   `rememberFromTurn` extracts durable goals/preferences (allowlisted + redacted
   — see §5).

**No chain-of-thought is ever surfaced.** The `GrowthAgentResponse` schema has
no `thinking` / `reasoningSteps` field; the user sees only **analysis summary ·
evidence · decisions · recommendations · actions**. `decisions` is one line per
capability used (what + why), not how the model thought.

**Actions.** A recommendation can become a `Task` (Title, Priority, Affected
URLs, Instructions, Status) via a Server Action. Actions that would change an
external system (publishing, metadata) are **proposed with
`requiresConfirmation` and never executed by the orchestrator** — the user
carries them out through that feature's own approval screen (ADR-0022).

### The planned general orchestrator (Phase 7 remainder)

`Orchestrator` (from `packages/core`): `route(request, ctx) → AgentId` and
`dispatch(task) → Result`.

**Flow for a user request**

1. **Intake.** User message or a triggered task enters with `AgentContext`
   (org, actor, goals, pinned entities, automation flags).
2. **Route.** `router` model classifies intent → one primary agent (or a small
   fixed plan, e.g. audit → auditor → recommendation → reporting).
3. **Plan.** For multi-step work the orchestrator builds a DAG of sub-tasks
   (bounded depth/width; a hard cap on total steps and total token budget).
4. **Execute.** Each sub-task = one `AgentRun`. Agents may request tools; the
   **tool registry** checks the agent's allowlist and the context's permissions
   before executing. `call_agent` lets an agent request another agent's output
   via the orchestrator (never directly), and is depth-limited.
5. **Approval gates.** A tool marked `sideEffects: external | destructive`
   creates an `AgentToolCall` in `AWAITING_APPROVAL` and pauses the run
   (`RunStatus = NEEDS_APPROVAL`) unless automation mode covers that action.
6. **Assemble.** `recommendation` + `reporting` agents produce the final
   structured output; the orchestrator persists `AgentRun`/`AgentToolCall`,
   emits `Recommendation`s, and notifies.
7. **Stop conditions.** Step cap, token/cost cap, wall-clock cap, repeated
   tool-failure, or "insufficient data" → the run ends with a partial,
   clearly-labelled result rather than guessing.

**Determinism & audit.** Every run records: inputs, model role + resolved
`ModelRef`, each tool call (args, result hash, duration, outcome), token counts,
cost, and the final output. Runs are replayable for debugging (tool results can
be pinned).

---

## 4. Tools

> **Phase 4 update.** The concrete implementation is
> `packages/services/src/agent/tool-registry.ts` (catalogues the existing
> closed `integration-tools.ts` allowlist with risk/category/provider-type
> metadata) plus `packages/ai`'s new `GenerateTextOptions.tools`/`maxSteps`
> (real Vercel AI SDK multi-step tool-calling, tested). Neither is wired
> into a live orchestrator capability yet — see `docs/AGENT-RUNTIME.md` §6
> for exactly what exists versus what's conceptual below, and why wiring
> it in was deliberately deferred.
>
> **Phase 5 update.** The conceptual "`search_web_public`"/"`enqueue_*`"
> naming below predates the real implementation; the actual tool names are
> `research.fetch` / `research.search` (read-only, no `enqueue`/`execute`
> tool exists or is planned — `docs/TOOL-PLATFORM.md` §6) and
> `mcp.<server>.<name>` for an org's explicitly enabled MCP tools
> (`docs/MCP.md`). A real
> Policy Engine (`agent/policy-engine.ts`) and a unified Tool Executor
> (`agent/tool-executor.ts`) now exist with the seven-outcome precedence
> model this document's "Permissioning"/"Rate/cost" bullets gestured at —
> see `docs/TOOL-PLATFORM.md` for the concrete architecture. As with the
> Phase 4 tool-calling primitive, **none of this is wired into the live
> orchestrator's turn loop yet.**

A tool = `{ name, description, parameters: ZodSchema, sideEffects, requiredScopes,
execute }`. The registry is the only place tools are defined.

- **Categories:** `read` (tenant-scoped data access), `compute` (pure/derived),
  `search` (public, ToS-bounded), `enqueue` (start a bounded job),
  `external`/`destructive` (mutate an external system or delete data).
- **Permissioning:** a tool call is allowed only if
  `tool.name ∈ agent.allowedTools` **and** every `tool.requiredScopes` is
  present in `AgentContext` (which derives from the actor's role, the org's
  connected integrations, and automation settings).
- **Data access:** `read_*` tools call `packages/services` repositories with the
  context's `organizationId` injected by the registry — an agent cannot widen
  scope by argument.
- **No raw SQL, no raw HTTP.** `search_web_public` and any fetch go through the
  SSRF-safe fetch layer (`SEO-ENGINE.md`) with allowlists and size/time caps.
- **Rate/cost:** tool calls count toward the run's step and cost budget;
  `enqueue_*` tools respect `usage.check`.

---

## 5. Memory & context

| Layer                | Store                                                                                                  | Lifetime              | Use                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------- |
| **Conversation**     | `AIConversation` + `AIMessage`                                                                         | until archived/purged | chat turns, tool transcripts                                          |
| **Working context**  | in-run, in memory                                                                                      | one run               | current task tree, intermediate findings, budgets                     |
| **Pinned context**   | `AIConversation.context` (Json)                                                                        | conversation          | goals, focus entities (a channel, a website), constraints             |
| **Semantic memory**  | embeddings of `Finding`/`Recommendation`/`CrawlIssue` summaries in Postgres (`pgvector`) scoped by org | rolling window        | `search_findings` retrieval, "what changed" diffs                     |
| **Historical facts** | the domain tables themselves (metrics, crawls)                                                         | per retention         | ground truth; agents read these, never a summarized copy, for numbers |

Context assembly for a run: system prompt (by agent id, versioned) + pinned
context + retrieved semantic memory (top-k, org-scoped) + the specific records
the task needs. Token budget per context section is capped; overflow is
summarized by the `router` model, never truncated silently.

**Implemented (Phase 7): controlled memory** — `agent/memory.ts` stores exactly
six `OrgMemory` kinds: `USER_GOAL`, `ORG_GOAL`, `PREFERENCE`,
`PAST_RECOMMENDATION`, `COMPLETED_TASK`, `ACTIVE_PROJECT`. Nothing else. Write
guards (master instruction "do not store sensitive information unnecessarily"):
only the allowlisted kinds; `value` capped at 300 chars, `label` at 60; a
redaction pass rejects any candidate that matches an email, phone number, API
key / token, long hex string, or credentialled URL. The model memory extractor
is constrained by the `MemoryExtraction` schema (no free-form kinds) and its
output is re-validated by the same guards. Memory rows are deduped on
`(organizationId, userId, kind, label)` and can carry an `expiresAt`.

**Implemented (Phase 11) — the knowledge layer + Context Assembly Engine.**
This section's original "Semantic memory" row planned embeddings of
`Finding`/`Recommendation`/`CrawlIssue` summaries; what actually shipped is
broader and typed: a new `KnowledgeItem` model (35 types, org/user/mission
scope, a 7-value fact/inference/hypothesis/opinion classification, 9-value
status, per-type freshness) with `KnowledgeEmbedding` chunks
(`vector(1536)`, real only when `OPENAI_API_KEY` is configured — see §1's
resilience/roles section, the `'embedding'` role now has a concrete
`embed()` behind it for the first time). `agent/context-assembly.ts`'s
`assembleAgentContext` is the actual, single place context is assembled
for a growth-agent turn or a mission plan — composing `OrgContext` +
`AgentMemory` (both unchanged) with hybrid-retrieved knowledge
(`knowledge·0.30 + vector·0.30 + importance·0.15 + confidence·0.15 +
recency·0.10` — never ranked by vector similarity alone), recent completed
research, and cross-mission learnings. Retrieved knowledge is folded into
the orchestrator's existing evidence catalogue via `evidenceKindFor`,
mapping the 7-value classification onto this doc's own `Claim` tagging
(`fact`/`calculated_metric`/`assumption`/`prediction`/`recommendation`) —
a stored hypothesis is graded by the identical grounding check
(`checkGroundingFields`) a capability's own evidence already is, never a
second tagging system. See `docs/KNOWLEDGE-INTELLIGENCE.md`, ADR-0060.

**Prompt-injection stance:** crawled page content, video metadata, API
payloads, and user-supplied text are **untrusted data**. They are never
concatenated into the instruction channel as commands, never allowed to change
tool authorization, tenant scope, budgets, or approval state.

**Implemented (Phase 22)** — every model prompt that carries external or
user-supplied text now fences it with `wrapUntrusted(label, text)` and every
such system prompt carries `UNTRUSTED_CONTENT_SYSTEM_CLAUSE`
(`packages/services/src/security/untrusted.ts`): the YouTube analyst
(`YOUTUBE_VIDEO_METADATA`), TikTok analyst (`TIKTOK_VIDEO_METADATA`),
monetization analyst (`MONETIZATION_SIGNALS` — business-profile free text),
content analyst (`SOURCE_CONTENT`) and generator (`CONTENT_ANALYSIS`), the
Growth Agent planner + orchestrator + memory extractor (`USER_MESSAGE`,
`CHAT_HISTORY`, `CAPABILITY_EVIDENCE`), and the SEO agent (`USER_QUESTION`,
`USER_GOALS`). The grounding check (`checkGroundingFields`) still runs _after_
the model as the second line of defence — an injected "state the number 999999"
or "guarantee a ranking" is dropped regardless of the fence.

**Implemented (Phase 25 — AI red team, `docs/AI-SECURITY-AUDIT.md`,
ADR-0040)** — `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` now states the trust
hierarchy **by name** (SYSTEM/DEVELOPER outranks USER outranks EXTERNAL DATA —
anything fenced by `wrapUntrusted`) and forbids the model from revealing or
paraphrasing its own system prompt, claiming to be a different or
"jailbroken" system, or treating a user-message claim of system/developer/admin
authority as real; a lower tier can never override a higher one. Two
code-level backstops don't rely on the model honoring that clause:
`agents/output-scrub.ts`'s `scrubModelOutput` deep-scrubs every agent's final
output (model path **and** deterministic fallback) for secret-shaped strings
before persistence/return, and `agent/orchestrator.ts`'s `finalizeBlocks`
unconditionally forces `requiresConfirmation: true` on every
`kind: 'external'` proposed action, closing the one field the grounding check
never examined. Adversarial coverage:
`packages/services/src/agents/ai-red-team.test.ts`.

---

## 6. Structured outputs

- Canonical schemas in `packages/core`: `Claim`, `Finding`, `Recommendation`,
  `AnalysisReport` (already shipped Phase 0).
- Agents use `generateObject(schema)`; a failed parse → one repair attempt with
  the validation error, then a typed `AgentError` (no free-text fallback that
  bypasses the schema).
- `AnalysisReport` = `{ generatedAt, subject, findings[], recommendations[],
disclaimers[] }`. Every `Finding.claims[]` and `Recommendation.evidence[]`
  entry is a `Claim` with `kind` + `evidence[]` sources.
- Numbers in outputs must originate from a `read_*`/`compute` tool result and
  carry an evidence pointer; the reporting agent rejects unsourced figures.

### Shared grounding check

`packages/services/src/agents/grounding.ts` `checkGroundingFields(fields,
knownFactIds, factNumbers)` is the reusable core: it flags cited fact ids that
don't exist, free-text numbers not in the fact sheet (allowing small integers,
years, and 0–100 percentages), and guarantee-style phrasing. Each analyst agent
provides a thin adapter that flattens its schema into `fields`. Used by the
YouTube and TikTok analysts.

### First implementation: the YouTube Analyst Agent

Shipped (see `YOUTUBE-INTEGRATION.md` §4). It establishes the pattern the other
analyst agents will follow:

1. **Fact sheet** — deterministic aggregation builds a list of
   `{ id, label, value, kind, origin }` facts from synced data. That plus recent
   video metadata is the _entire_ quantitative context the model gets.
2. **Schema** — `YouTubeAnalysis` requires `evidenceFactIds` on every finding,
   recommendation, and suggestion.
3. **Grounding check** (`youtube/grounding.ts`) — before persistence: cited fact
   ids must exist; free-text numbers must match a fact value (±2 %) or be
   obviously safe; no guarantee phrasing. One repair attempt, then the run
   `FAILED`s and throws `AgentGroundingError`. Ungrounded output is never shown.
4. **Thin data** (< 3 videos) → deterministic minimal report, no model call.
5. Persisted as `AgentRun` (tokens + cost) + `Recommendation` (`domain=YOUTUBE`,
   `evidence` = cited facts as `Claim`s) + `ContentIdea`.

### Content repurposing (`content-analyst` + `content-generator`)

`packages/services/src/content` runs a two-model pipeline: `analyze.ts` produces
one grounded `ContentAnalysis` (summary, key ideas — each with an optional
**verbatim** source quote, content angles), then `generate.ts` makes one
`generateObject` call per requested deliverable (13 types) building on those key
ideas. Grounding is deliberately light for a creative stage — non-verbatim
quotes are dropped and guarantee phrasing falls back to a deterministic template,
but paraphrase and invented hooks are allowed. Every stage has a deterministic
path, so the engine works with no AI key. Output is stored as editable, versioned
`ContentAsset` / `ContentAssetVersion` rows; the engine never publishes
(ADR-0023, `docs/CONTENT-REPURPOSING.md`).

### Monetization analyst (`monetization-analyst`)

`packages/services/src/monetization` is **deterministic-first**:
`buildOpportunities(signals)` decides which of the 11 channels apply and computes
the seven required fields + a `priorityScore` with no model involvement. The
model (`MonetizationAnalysis`) may only rewrite the `overview` and per-channel
`description` / `requiredActions`; its output is flattened and checked with
`checkGroundingFields` against a signal fact sheet (`s1..sN`), one repair
attempt, then **dropped** to the deterministic text on any grounding issue. It
never produces numbers and never claims platform-program qualification —
PLATFORM_MONETIZATION readiness is derived entirely from the conservative
`assessMonetization` result and defers the decision to the platform. Persisted as
an `AgentRun` (`agent: 'monetization-analyst'`). Revenue is never written here —
it is a read-only signal (ADR-0024, `docs/MONETIZATION.md`).

### Reporting engine (`reports/summary.ts`)

The report **data** — key metrics, problems, opportunities, recommendations,
priority actions, the historical diff — is assembled deterministically from the
other modules' read functions; a model is never in that path. The **executive
summary** is deterministic by default; when a model is available it gets one
grounded pass (`checkGroundingFields` against an id-tagged fact sheet built from
the same facts), and is **dropped** back to the deterministic assembly on any
grounding issue or model error. It never guarantees an outcome. Everything is
then frozen into an immutable `ReportSnapshot` (ADR-0026, `docs/REPORTING.md`).

### Same pattern: TikTok Analyst + SEO Auditor

`tiktok/analyst.ts` and `seo/audit-summary.ts` reuse the shared
`checkGroundingFields` verbatim. The **SEO Auditor Agent** (`agent: 'seo-auditor'`)
summarizes one finished `Crawl`: its fact sheet is built deterministically from
the crawl's category scores, issue counts by severity/category, the top 15
issues (with affected-URL counts), and a few crawl-summary aggregates. It emits
`CrawlAuditAnalysis` (`headline`, `overview`, `keyObservations[]`,
`prioritizedActions[]`, `disclaimers[]`), every observation and action citing
`evidenceFactIds`. The system prompt forbids inventing numbers and forbids
predicting or promising search rankings. Thin crawls (< 3 pages, or no scores)
skip the model and return a deterministic minimal summary. Grounded output
persists `Recommendation`s with `domain = SEO`.

### The AI SEO Agent (`agent: 'seo-agent'`, Phase 6)

A step up from the auditor. It reasons over an **already-run** crawl through a
closed allowlist of nine **read-only** `seo.*` tools (`seo/agent-tools.ts`) —
there is no write tool, so it cannot change a website, and it never crawls. Each
tool call is org-scoped and logged on the `AgentRun`.

The ranking is **deterministic** (`seo/recommendation-engine.ts`): issues are
grouped by code and scored 0–100 on six published factors (severity, reach,
business importance — with a goal-based nudge, estimated impact, implementation
ease, confidence), then bucketed into Quick Wins / High Impact / Technical
Projects / Long-Term Improvements. A deterministic machine-readability analysis
(`seo/ai-readability.ts`) scores nine signals, each labelled _established_
(documented search-engine guidance) or _experimental_ (AI-search guidance).

The model is **optional and narrative-only**: one grounded `generateObject` pass
refines wording and answers the user's question. If its free text fails the
shared grounding check after one repair, it is dropped and deterministic
templates are used — the numbers never depend on the model. The agent never
predicts or promises rankings. Output is the full `SeoAgentReport` on the
`AgentRun`; recommendations persist with `priorityScore` + `actionPlan`.

---

## 7. Safety controls (summary)

| Control              | Mechanism                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No fabricated data   | structured outputs + evidence requirement + "no data" is valid + eval suite                                                                                            |
| No guarantees        | system prompts forbid it; a lint of output strings flags "guarantee/guaranteed ranking/approval" for review in eval                                                    |
| Least privilege      | per-agent `allowedTools`, per-tool `requiredScopes`, org-scoped `read_*`                                                                                               |
| Human approval       | `external`/`destructive` tools → `AWAITING_APPROVAL`; automation mode is explicit + revocable + audited                                                                |
| Cost control         | model roles, per-call **timeout**, `usage.enforceUsage` (per-org) + `usage.enforceAiUserLimit` (per-user), `UsageRecord` + `costUsd` on every call, `pricing.ts` table |
| Isolation            | agent context carries exactly one `organizationId`; registry injects it                                                                                                |
| Injection resistance | untrusted content fenced with `wrapUntrusted` + standing trust-hierarchy clause on every prompt (see §5); grounding check after                                        |
| Output scrubbing     | `agents/output-scrub.ts`'s `scrubModelOutput` redacts secret-shaped strings from every agent's final output (model path and deterministic fallback alike), Phase 25    |
| Forced confirmation  | `agent/orchestrator.ts`'s `finalizeBlocks` sets `requiresConfirmation: true` on every external proposed action unconditionally — never model-trusted, Phase 25         |
| Auditability         | full `AgentRun` / `AgentToolCall` records; replayable                                                                                                                  |
| Kill switch          | `AI_DISABLED` (whole layer) / `AI_DISABLED_PROVIDERS` (one provider), checked per call in `withResilience`; `CRAWLER_HALT` for crawls                                  |

---

## 8. Evaluation

- **Adversarial suite (implemented, Phase 22)** —
  `packages/services/src/agents/adversarial.test.ts` covers the attack classes
  from the master instruction: prompt injection (a malicious video title reaches
  the model fenced; a model that "obeys" it — leaked secret + invented number +
  guarantee — is caught by grounding and the run FAILs), malicious website /
  content (injection + guarantee phrasing → deterministic fallback), fabricated
  analytics (a number not in our fact sheet is rejected; a real one passes),
  conflicting data (no synthesised "reconciled" third number), missing data
  (deterministic minimal report, **no model call**), and invalid tool calls
  (`executeSeoTool` rejects any non-allowlisted name; a foreign `organizationId`
  in tool input is ignored — the read stays scoped to the context org).
  `packages/ai/src/{resilient,fallback,roles}.test.ts` cover the resilience
  layer.
- **AI red team (implemented, Phase 25)** —
  `packages/services/src/agents/ai-red-team.test.ts` attacks the layer as a
  malicious user: instruction hijacking / system-prompt extraction (a hijack
  attempt reaches the model fenced, never adopted), secret exposure (an API
  key, a JWT, and a connection string embedded in a model response, and in a
  capability's own evidence on the deterministic path, are redacted before
  persistence), unauthorized external actions (a model-asserted
  `requiresConfirmation: false` is forced to `true` on both the model and
  deterministic paths), cross-tenant access (a capability's underlying read
  stays scoped to the server-derived org regardless of an org id embedded in
  the user's message), tool manipulation (an oversized limit and a
  `__proto__`-keyed payload are rejected/inert), and indirect injection via
  malicious SEO content (a marker planted in a crawl fixture's page
  title/meta description is proven absent from the actual model prompt, not
  just assumed from reading the code). See `docs/AI-SECURITY-AUDIT.md`.
- **Golden-set evals** per agent (fixed inputs → schema validity, claim tagging,
  evidence presence, banned-phrasing absence) — the analyst `*.test.ts` files.
- **Regression:** every bug fix adds a case.
- Real model calls never run in CI; a nightly job runs a small live eval in
  staging.
