# KNOWLEDGE-INTELLIGENCE.md — Memory, Research & Knowledge Intelligence (Phase 11)

## 1. Audit findings (mandatory first step)

Before writing any code, the existing memory/AI/research/knowledge surface
was audited in full (a 20-question map covering `agent/memory.ts`,
`agent/context.ts`, `agent/orchestrator.ts`, the Phase 5 Tool Registry/
Policy Engine, `agent/capabilities.ts`, Phase 10 missions, RBAC, the
untrusted-content fence, the SSRF-safe fetch client, the worker/BullMQ
architecture, `packages/ai`'s provider interface, usage meters,
notifications, uploads, nav structure, and the Prisma schema's existing 78
models). Confirmed findings that shaped every decision below:

- **`OrgMemory` (Phase 7)** is a narrow, six-`MemoryKind` store for cross-
  turn goals/preferences, upsert-only, no fact/inference distinction, no
  conflict detection, an `expiresAt` field nothing ever populates. It stays
  exactly what it is — Phase 11 does not touch its extraction path.
- **`MissionLearning` (Phase 10)** already has the Observation/Hypothesis/
  Learning/Decision distinction the brief asks for, but is mission-scoped
  and has no cross-mission read. Phase 11 adds one (`listRecentLearnings`)
  rather than duplicating the model.
- **Embeddings**: `packages/ai`'s `EmbedOptions`/`AIProvider.embed?` and a
  `'embedding'` model role already existed, fully typed, with **zero
  concrete implementation and zero call sites** — a seam, not a feature.
  Phase 11 implements it for OpenAI's `text-embedding-3-small` (the role's
  existing default) and nothing else.
- **pgvector**: not enabled anywhere in the schema or migrations. Fully new
  this phase (`CREATE EXTENSION vector`, a `vector(1536)` column).
- **Research**: `research/{fetch,search,extract,tools}.ts` (Phase 5) is a
  stateless, read-only tool pair — `research.fetch`/`research.search` — with
  no persistence and no configured search provider (`searchProviderFromEnv()`
  always returns `null`, a deliberate, disclosed choice). Phase 11 builds
  `ResearchProject` persistence and a real lifecycle **on top of** these
  primitives, never replacing them, and does not reuse their tool names.
- **Knowledge/documents**: no model, no upload route, no storage adapter
  anywhere. Object storage is not implemented (confirmed again — still
  true). Ingestion in this phase is text/URL only, disclosed in §14 below.
- **Tool Registry / Policy Engine (Phase 5)**: `AgentToolMetadata`
  (category/riskLevel/requiresApproval/providerType), `executeAgentTool`'s
  `kindOf`/dispatch pattern, and the closed per-domain tool files
  (`youtube-tools.ts`, etc.) are the exact template every new tool file in
  this phase follows.
- **Context assembly**: no centralized abstraction existed. `orchestrator.ts`
  built `OrgContext` + `AgentMemory` + a flat `history: string[]` itself;
  every capability read its own domain data ad hoc. This is the real gap
  Part 28 asks to close.

## 2. What this phase does NOT duplicate

| Brief's ask | Existing system | This phase's decision |
| --- | --- | --- |
| Fact/inference/hypothesis tagging | `EvidenceItem.kind` (`fact\|calculated_metric\|assumption\|prediction\|recommendation`, master instruction hard rule 1) | `KnowledgeClassification` maps onto it (`evidenceKindFor`) rather than inventing a second vocabulary |
| Mission learning | `MissionLearning` (Phase 10) | Untouched; a new cross-mission read added |
| Conversation memory | `OrgMemory` (Phase 7) | Untouched; `MemoryCandidate` sits in front of the NEW, broader `KnowledgeItem` store only |
| Tool authorization | Policy Engine + Tool Registry (Phase 5) | New `knowledge`/`research.project`/mcp-style tool files follow the identical pattern; no new authorization model |
| SSRF-safe fetch | `seo/fetch.ts::fetchPage`, reused by `research/fetch.ts` | Reused again for document-URL ingestion and the research engine — a third SSRF implementation was never written |
| Untrusted-content fencing | `security/untrusted.ts` | Reused verbatim for research synthesis and knowledge context in prompts |
| Worker/job system | BullMQ, the `agent-run` queue (reactivated Phase 10) | New knowledge/research jobs ride the SAME queue; no second worker system |
| RBAC | `rbac/permissions.ts` capability catalog | Six new permissions added to the existing catalog and role arrays, following the `<domain>.view`/`<domain>.manage` convention exactly |

## 3. The knowledge model

Six new tables realize Part 3-7/16/24/37 of the brief:
`KnowledgeSource`, `KnowledgeItem`, `KnowledgeEvidence`, `KnowledgeEmbedding`,
`KnowledgeRelation`, `KnowledgeConflict`. A seventh, `MemoryCandidate`, is
the governance gate in front of `KnowledgeItem` creation from conversation.

`KnowledgeItem` carries, per Part 3-5/23/36: `type` (35 values), `scope`
(`USER`/`ORGANIZATION`/`MISSION`), `classification` (`FACT`/`INFERENCE`/
`HYPOTHESIS`/`OPINION`/`USER_PROVIDED`/`SYSTEM_OBSERVED`/`EXTERNAL_SOURCE`),
`confidence` (0-1), `importance` (`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`), `status`
(9 states), `freshnessPolicy` + `expiresAt`/`lastVerifiedAt`/`lastUsedAt`.
**`VERIFIED` is set by exactly one function, `verifyKnowledgeItem`** — never
by the extractor, the research engine, or on creation, no matter how
confident the source (Part 4's own instruction).

### Named models the brief lists that were deliberately not created

- `ResearchSource` folds into the shared `KnowledgeSource` — a citation and a
  knowledge item's source are the same concept; a separate table would
  duplicate it.
- A dedicated `KnowledgeGraph` database — a relational `KnowledgeRelation`
  table is sufficient (Part 24 explicitly allows this) and needs no graph
  engine.
- `TEAM`/`PROJECT`/`INTEGRATION`/`CONVERSATION`/`GLOBAL_PUBLIC` retrieval
  scopes (Part 18) — this deployment has no team-vs-org distinction, project
  entity, per-integration partition, or seeded public knowledge base to
  scope against; building the machinery for four unused scopes would be
  exactly the kind of "planned but not implemented" surface this project's
  own audits have repeatedly flagged. `USER`/`ORGANIZATION`/`MISSION` are
  real and enforced.

## 4. Fact vs. inference vs. hypothesis, operationalized

`evidenceKindFor()` (`knowledge/schemas.ts`) maps the 7-value
`KnowledgeClassification` onto the pre-existing `EvidenceItem.kind`
vocabulary, so knowledge injected into the orchestrator's evidence
catalogue is graded by the **same** grounding machinery
(`checkGroundingFields`) that already refuses ungrounded claims — not a
second, parallel tagging system:

```
FACT / USER_PROVIDED / SYSTEM_OBSERVED / EXTERNAL_SOURCE  → 'fact'
INFERENCE                                                  → 'calculated_metric'
HYPOTHESIS / OPINION                                       → 'assumption'
```

This directly ties Phase 11 to the master instruction's hard rule 1 (tag
every statement `fact | calculated_metric | assumption | prediction |
recommendation`) — a rule every prior phase honored inside its own domain
but which the knowledge layer now enforces structurally for anything
retrieved from storage.

## 5. Source trust — a transparent rule, not an "AI score"

`trustLevelFor(sourceType)` (`knowledge/schemas.ts`) is a pure, documented
switch, never a model's opinion:

```
INTERNAL_ANALYTICS / MISSION_RESULT / EXPERIMENT_RESULT → VERY_HIGH
YOUTUBE / TIKTOK / GOOGLE_SEARCH_CONSOLE / WORDPRESS     → HIGH
USER_INPUT / UPLOADED_DOCUMENT                           → MEDIUM
WEBSITE_CRAWL / WEB_RESEARCH                             → LOW
AI_GENERATED (default)                                   → UNKNOWN
```

## 6. Freshness (Part 23/36)

`FRESHNESS_POLICIES` is one small table (`permanent`/`long`/`medium`/
`short`/`very_short`, `ttlDays` or `null`), and `DEFAULT_FRESHNESS_BY_TYPE`
maps every one of the 35 knowledge types to a policy — a business/brand
profile is `long` (365 days), a YouTube/TikTok/performance observation is
`short` (14 days), market/trend data is `very_short` (3 days), and a mission
experiment/decision/learning is `permanent` (never auto-expires, matching
the brief's own examples verbatim). `knowledge.freshness.check` (a
repeatable worker tick) demotes anything past its `expiresAt` to `STALE` —
old data is never silently treated as current.

## 7. Conflict detection (Part 37)

`detectConflictsForItem` is a deliberately conservative heuristic: two
items of the **same type and scope**, with **high title-keyword overlap**
(same topic) but **low content-keyword overlap** (materially different
claims), are flagged — both sides move to `CONFLICTED`, a `KnowledgeConflict`
row is created, and the org gets a notification. Nothing is silently
resolved by picking a side; `resolveConflict` is the only function that
changes either item's terminal status, and only when a human explicitly
names a winner (or explicitly says both hold in their own context, which
clears both back to `ACTIVE` without a verdict).

## 8. Duplicate detection / consolidation (Part 53-54)

`findDuplicateCandidates` groups same-type/scope items and scores content
overlap (Jaccard on normalized tokens); a pair at or above 0.6 similarity is
surfaced as a candidate. `consolidateInto` is a separate, explicit, audited
action — the survivor is untouched, the merged item is archived and linked
via a `DERIVED_FROM` relation, never silently deleted. This is a manual
workflow this phase does not attach a dedicated UI page to (disclosed in
§13) — the service functions exist and are tested, invoked today only via
direct call (a future admin/UI surface is the natural next slice).

## 9. Embeddings & hybrid retrieval (Part 16-17)

`packages/ai/src/providers/vercel.ts` gained an optional `embed()`
implementation, wired only into the OpenAI factory (`client.textEmbeddingModel`,
via the Vercel AI SDK's `embedMany`) — Anthropic/Google providers are
untouched and still have no `embed`. Every existing generic seam
(`resilient.ts`'s timeout wrapper, `fallback.ts`'s cross-provider chain,
`registry.ts::getForRole('embedding')`) picks this up automatically; no
call site outside the two provider files needed to change.

`knowledge_embeddings.embedding` is a Prisma `Unsupported("vector(1536)")`
column — Prisma Client has no native vector type, so every read/write goes
through `$executeRaw`/`$queryRaw` (`knowledge/embeddings.ts`). The migration
runs `CREATE EXTENSION IF NOT EXISTS vector` first; if the extension isn't
available on the target Postgres, every vector-touching function catches
the error, logs once, and returns `null`/`[]` rather than throwing —
**retrieval never depends on it being present**.

`retrieveKnowledge` (Part 17) blends five signals, never vector similarity
alone:

```
score = keyword·0.30 + vector·0.30 + importance·0.15 + confidence·0.15 + recency·0.10
```

Keyword and vector candidate pools are unioned (a chunk can match
semantically without sharing a keyword, and vice versa) before scoring.
With no embedding provider configured, `vector` contributes 0 for every
candidate and ranking degrades to keyword + metadata only — a real,
tested fallback path, not a hypothetical one.

## 10. Document ingestion (Part 13-15) — text and URL only, disclosed

This deployment has no object storage and no PDF/DOCX parsing dependency
(CLAUDE.md hard rule 9: avoid unnecessary dependencies). `ingestDocument`
therefore accepts **pasted text** or a **public URL** (fetched through
`seo/fetch.ts`'s existing SSRF-safe client via `research/fetch.ts`, never a
second implementation) — never a binary file upload. `chunking.ts`'s
`chunkDocument` is markdown-heading-aware: a `#`/`##`/… heading starts a new
chunk (carried as `heading` metadata alongside `paragraphIndex`), otherwise
paragraphs are packed up to a character budget, with a hard split only for a
single paragraph that alone exceeds it.

## 11. The research lifecycle (Part 8-12)

`ResearchProject` → `ResearchQuery` → `ResearchFinding` → `ResearchCitation`,
statuses `REQUESTED → PLANNING → SEARCHING → COLLECTING → ANALYZING →
VERIFYING → COMPLETED|PARTIALLY_COMPLETED|FAILED|CANCELLED`. The engine
(`research/engine.ts`) is honest about a real limitation: `research/search.ts`
(Phase 5) has no configured web-search provider in this deployment, so
`SEARCHING` never finds anything **today** — source discovery is driven
entirely by the caller's own `config.seedUrls` (capped at 10, a hard
ceiling independent of what's requested, Part 67). A project with no seed
URLs and no provider fails honestly (`FAILED`, a plain-English reason) —
never a fabricated result. Each successfully fetched URL becomes a
`KnowledgeSource` (dedup'd by URL+contentHash) + a `ResearchFinding` (the
excerpt) + a `ResearchCitation`; an optional grounded model pass then
synthesizes a `conclusion` **only from the fetched excerpts**, wrapped with
`wrapUntrusted` before it ever reaches a prompt — dropped entirely on any
grounding/provider failure, never inventing a conclusion. A `COMPLETED`
project with a conclusion also creates one `KnowledgeItem` (`type: RESEARCH`,
`classification: EXTERNAL_SOURCE`, `status: UNVERIFIED` — research is never
auto-verified) so future retrieval can find it.

**"Runs asynchronously" (Part 82), the real mechanism**: this codebase has
no web→worker job producer anywhere — `apps/web` doesn't depend on `bullmq`
at all. Every existing background flow instead has the **worker's own
repeatable tick** discover pending work and process it in-process, exactly
`missions/loop.ts::runMissionSweep`'s shape. `research.project.create` only
ever creates a `REQUESTED` row and returns immediately; a new
`research-dispatch-sweep` tick (every 30s, on the same `agent-run` queue)
picks it up and calls `runResearchProject` directly. `research.project.get`
is how a caller polls status — there is no live-streaming UI for research
(disclosed in §13).

## 12. Context Assembly Engine (Part 28-30, 87)

`agent/context-assembly.ts::assembleAgentContext` is the single place that
composes: `OrgContext` (reused, unchanged), `AgentMemory` (reused,
unchanged), `retrieveKnowledge` (new), recent completed `ResearchProject`s
(new), and cross-mission `MissionLearning`s via a new
`listRecentLearnings` (extends, doesn't duplicate, Phase 10's model). It
does **not** replace `loadOrgContext`/`loadMemory` — it calls them
internally, so nothing downstream that already depended on their exact
shape needed to change.

`agent/orchestrator.ts`'s gather stage now calls `assembleAgentContext`
once, instead of the previous bare `Promise.all([loadOrgContext, loadMemory])`.
The three new reads are individually wrapped so a failure in any one of
them (a fixture without the Phase 11 tables, a transient DB hiccup)
degrades to "no extra context for this enhancement" rather than failing the
whole turn — the same `needs_prerequisite`/`error` degrade-gracefully
convention every capability already follows.

Retrieved knowledge, recent research conclusions, and cross-mission
learnings are folded into the orchestrator's **existing** evidence
catalogue (the one `checkGroundingFields` already enforces), tagged via
`evidenceKindFor` — a stored hypothesis can never be cited by the model as
an established fact. `AgentContext.usedSources` — plain labels like "Your
stored business knowledge", "Prior research", "Lessons from previous
missions" — is computed **independently of model output** (never trusted
from the model) and surfaces in the chat UI's "Used:" line (Part 44), and
in a new `GrowthAgentResponse.usedSources` field (additive, defaulted, no
breaking change to the existing schema).

A deterministic, zero-cost detector (`knowledge/extract.ts`) also runs
after every successful turn, alongside (not instead of) `rememberFromTurn`'s
existing `OrgMemory` extraction — a handful of regex patterns for
"our target market is…", "we sell…", "our brand is…", etc. — feeding
`proposeMemoryCandidate` so the governance flow (§13 below) has a real,
always-on floor without adding a second model call to every turn.

## 13. Memory governance (Part 20-22)

A statement worth remembering becomes a `MemoryCandidate`, not an
immediately-live `KnowledgeItem`. `isSafeToAutoAccept` only fires for a
`USER_PROVIDED`, `LOW`/`MEDIUM`-importance, ≥0.75-confidence candidate —
anything `HIGH`/`CRITICAL` importance always waits for a human, no matter
how confident the extractor claims to be. Accepting creates a real
`KnowledgeItem`; rejecting creates nothing. Duplicate unreviewed candidates
for the same statement supersede rather than pile up in the review queue.

## 14. Missions integration (Part 45, 85)

`missions/planner.ts::gatherKnowledgeContext` (new) retrieves relevant
`KnowledgeItem`s and cross-mission `MissionLearning`s **before** a plan is
drafted, folding FACT/USER_PROVIDED/SYSTEM_OBSERVED/EXTERNAL_SOURCE
knowledge into `evidence` and INFERENCE/HYPOTHESIS/OPINION into
`assumptions` — the same distinction applied everywhere else in this
phase. `refineNarrative`'s optional model pass can reference a prior
lesson, but is explicitly instructed never to present a HYPOTHESIS-labelled
lesson as a proven fact. `planMission`/`generateMissionPlan` gained
optional `model`/`embeddingModel` parameters (previously `planMission`
never passed a model at all — a real, pre-existing gap this phase closed
in passing, since Phase 10 wired the refinement path but never its only
caller); the Server Action resolves both via the same
`growthAgentDepsFromEnv` the chat agent already uses.

## 15. Tools (Part 31-32)

Two new closed tool files, following the Phase 5 Tool Registry pattern
exactly (own `TOOL_NAMES` array, own metadata record, dispatched through
`executeAgentTool`'s `kindOf`):

- `knowledge/tools.ts` — `knowledge.search`/`get`/`create`/`update`/
  `archive`, `memory.propose`/`search`, `evidence.search`/`get`. All LOW
  risk, no governance/approval gate (none of these touch an external
  system — the worst case is a wrong, later-corrected, internal record).
- `research/project-tools.ts` — `research.project.create`/`get`/`list`,
  namespaced separately from the pre-existing `research.fetch`/
  `research.search` (Phase 5) so neither collides with the other.

`agent/tool-executor.ts` gained two new dispatch kinds (`knowledge`,
`researchProject`); `agent/tool-registry.ts` gained their metadata and
folded them into `listToolMetadata()`. No new authorization path — the
existing per-org/per-tool rate limit and `TOOL_CALLS` meter apply
unchanged.

## 16. Cost control (Part 67)

A new `RESEARCH_CALLS` usage meter (added to the `UsageMeter` Prisma enum,
`usage/meters.ts`, and every tier's limit in `billing/plans.ts` — FREE 0,
CREATOR 25, PRO 150, AGENCY 750, ENTERPRISE unlimited) meters every
external fetch a research project makes, separate from `TOOL_CALLS`, so
research spend can be capped independently. Embedding calls report their
real token cost to the existing `AI_TOKENS` meter via `recordUsage`,
idempotency-keyed per ingestion/query call — an autonomous mission can
never trigger unlimited external research or embedding spend.

## 17. Security

- Every new Prisma model added to `scripts/check-tenant-scope.mjs`'s
  `TENANT_MODELS` allowlist — the CI tenant-scope lint now covers this
  phase's own queries, not just future ones (Phase 10's own mission models
  were never added to this list; this phase does not retroactively fix
  that pre-existing gap, out of scope here).
- Fetched web content (document-URL ingestion, research citations) is
  **never** passed to a model without `wrapUntrusted` — reusing the exact
  same fence every other agent/analyst in this codebase already uses, not
  a new one.
- `research/engine.ts`'s synthesis prompt wraps both the user's original
  question and every fetched excerpt separately, so a page crafted to say
  "ignore prior instructions" is fenced data, not an instruction, exactly
  like the crawler/content/SEO agents' existing defense.
- Tenant isolation: every new service function takes a server-derived
  `organizationId` as a required parameter; `retrieveKnowledge`,
  `getKnowledgeItem`, `getResearchProject`, etc. all filter by it —
  verified in `retrieval.test.ts`/`items.test.ts`/`context-assembly.test.ts`
  (a second org's knowledge is never returned).
- No new RBAC system: six permissions (`knowledge.view`/`manage`,
  `memory.view`/`manage`, `research.view`/`run`) added to the existing
  capability catalog, VIEWER/MEMBER+ exactly like every other domain.

## 18. What was deliberately not built

- **Binary document upload** (PDF/DOCX) — no object storage, no parsing
  dependency exists; text/URL ingestion only (§10).
- **A real web-search provider** for `research.search`/`SEARCHING` — no
  API-key infrastructure exists in this deployment (matches Phase 5's own
  disclosed limitation, unchanged).
- **A knowledge-graph visualization UI** — `KnowledgeRelation` rows exist
  and are readable (`listRelationsFor`, surfaced on the detail page as
  plain text links); no interactive graph view.
- **A dedicated consolidation/duplicate-review UI page** — the service
  functions (`findDuplicateCandidates`/`consolidateInto`) are built and
  tested, invoked today only via direct call; no `/app/knowledge/duplicates`
  page.
- **CSV/Markdown knowledge export** — JSON only (`knowledge/export.ts`),
  mirroring `agent/conversations.ts::exportConversation`'s existing
  precedent; a knowledge item's content is free text, not tabular, so JSON
  loses nothing CSV would add.
- **Live-streaming research progress in the UI** — the detail page shows
  the current stage on load; refreshing shows progress, there is no SSE
  stream for research the way the chat turn has one.
- **A model-driven, agent-selected tool-calling loop** using these new
  tools — `packages/ai`'s real tool-calling support (Phase 4) still isn't
  wired into any live orchestrator capability for knowledge/research any
  more than it was for YouTube/TikTok/WordPress before Phases 6/7/9; the
  new tools exist for a future capability to call, matching this
  codebase's established incremental pattern.
- **A wall-clock timeout on one research engine run** — bounded by its own
  `maxSources` ceiling and per-fetch timeouts inside `fetchPage`, but no
  overall run-duration cap; the same disclosed gap as the Phase 4 turn loop
  and the Phase 10 mission tick.

## 19. Known limitations, disclosed

- **No live verification.** No live OpenAI API key, no real Postgres with
  `pgvector` installed, and no live external web content was available in
  this sandbox. Every new module was verified by unit/integration-style
  tests against hand-built fixtures and the shared in-memory DB harness
  (extended with 11 new model stubs) only — the same disclosed limitation
  as every prior phase. The pgvector-specific raw-SQL paths
  (`knowledge/embeddings.ts`) are exercised only via their graceful
  -degradation branch in tests (no embedding model / no vector extension);
  the actual `INSERT ... ::vector` / `<=>` cosine-distance SQL has not run
  against a real Postgres with the extension installed.
- **No mission-specific or knowledge-specific adversarial red-team pass**
  beyond reusing the existing shared prompt-injection/instruction-hierarchy
  tests unchanged (matches Phase 10's own disclosed gap for missions).
- **`scripts/check-tenant-scope.mjs` still doesn't cover Phase 10's mission
  models** — noticed while extending the allowlist for this phase's own
  models, not fixed here (out of the requested scope).
