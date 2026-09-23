# PHASE 11 COMPLETE — Memory, Research & Knowledge Intelligence

Full detail is in `docs/KNOWLEDGE-INTELLIGENCE.md` and ADR-0060
(`docs/DECISIONS.md`). This report follows the brief's own §91 template.

## What was implemented

1. **A typed knowledge model** — `KnowledgeItem` (35 types, 3 scopes, 7
   classifications, 9 statuses, confidence/importance, per-type freshness
   policy), `KnowledgeSource` (12 source types, 5 trust levels, transparent
   rule-based), `KnowledgeEvidence` (claim → source), `KnowledgeEmbedding`
   (pgvector-backed chunks), `KnowledgeRelation` (10 relation types),
   `KnowledgeConflict` (surfaced, never silently resolved).
2. **Memory governance** — `MemoryCandidate` sits in front of every
   conversation-derived statement; auto-accept only for a directly
   user-provided, low-stakes, high-confidence statement, everything else
   waits for a human in the Knowledge Center.
3. **A real embedding provider** — OpenAI's `text-embedding-3-small`, wired
   into `packages/ai`'s previously-typed-only `embed()` seam.
4. **Hybrid retrieval** — keyword + vector + importance + confidence +
   recency, never vector alone; degrades to keyword+metadata with no
   provider configured.
5. **A research lifecycle** — `ResearchProject` → 10 states, URL-driven
   (no search provider configured in this deployment, disclosed), with
   real citations/findings and an optional grounded synthesis.
6. **A Context Assembly Engine** — `assembleAgentContext` composes org
   context, memory, retrieved knowledge, recent research, and cross-mission
   learnings into one `AgentContext`, wired into the growth-agent
   orchestrator and the mission planner.
7. **Knowledge-aware missions** — the planner retrieves stored knowledge
   and prior lessons before drafting a plan; found and fixed a real,
   pre-existing gap (`planMission` never actually passed a model to the
   planner before this phase).
8. **New tools** — `knowledge.*`/`memory.*`/`evidence.*` and
   `research.project.*`, both closed allowlists on the existing Tool
   Registry/Policy Engine.
9. **UI** — `/app/knowledge` (overview, detail, add, memories-to-review,
   conflicts) and `/app/research` (list+create, detail).

## Existing functionality reused

`OrgMemory` (Phase 7, untouched), `MissionLearning` (Phase 10, untouched,
one new cross-mission read added), the Tool Registry/Policy Engine (Phase
5), `executeAgentTool`'s dispatch pattern, `seo/fetch.ts`'s SSRF-safe
client (via `research/fetch.ts`, reused a third time for document-URL
ingestion), `security/untrusted.ts`'s fencing, the `agent-run` BullMQ queue
(Phase 10 reactivated it; Phase 11 adds more job types to the same queue),
`EvidenceItem.kind`'s existing grounding vocabulary (`evidenceKindFor`
maps onto it instead of a second tagging system), the RBAC permission
catalog's `<domain>.view`/`<domain>.manage` convention, and
`agent/conversations.ts::exportConversation`'s JSON-export precedent.

## Database changes

One additive migration, `20260929120000_knowledge_intelligence`:

- One new `UsageMeter` enum value (`RESEARCH_CALLS`).
- `CREATE EXTENSION IF NOT EXISTS vector`.
- 10 new enums (`KnowledgeClassification`, `KnowledgeStatus`,
  `KnowledgeScope`, `KnowledgeImportance`, `KnowledgeType`,
  `KnowledgeSourceType`, `SourceTrustLevel`, `KnowledgeRelationType`,
  `KnowledgeConflictStatus`, `MemoryCandidateStatus`, `ResearchStatus`).
- 11 new tables (`knowledge_sources`, `knowledge_items`,
  `knowledge_evidence`, `knowledge_embeddings`, `knowledge_relations`,
  `knowledge_conflicts`, `memory_candidates`, `research_projects`,
  `research_queries`, `research_findings`, `research_citations`).

No drops, no destructive changes. `prisma validate`/`prisma generate`
clean; hand-authored by the same review-by-eye process every migration
since Phase 10 has used (no live DB in this sandbox to diff against).

## API changes

New GET routes: `/api/knowledge`, `/api/knowledge/[knowledgeId]`,
`/api/knowledge/conflicts`, `/api/knowledge/memories`, `/api/research`,
`/api/research/[researchId]`. Mutations are Server Actions
(`apps/web/src/server/knowledge-actions.ts`,
`apps/web/src/server/research-actions.ts`), matching every prior phase's
convention.

## Worker/job changes

Five new job types on the existing `agent-run` queue:
`knowledge.freshness.check` (hourly), `knowledge.conflict.detect`
(every 4h), `memory.expire` (daily), `research.dispatch.sweep` (30s — the
real "runs asynchronously" mechanism for research), `research.cleanup`
(hourly, stale-run recovery), plus an on-demand `research.execute`. No new
queue.

## AI architecture changes

`packages/ai`'s `VercelAIProvider` gained an optional `embed()`
implementation, wired only into the OpenAI provider factory. Every
existing generic seam (`resilient.ts`, `fallback.ts`,
`registry.getForRole('embedding')`) picked it up with zero other code
changes. `GrowthAgentDeps` gained an `embeddingModel` field;
`growthAgentDepsFromEnv` resolves it via the existing `'embedding'` model
role.

## Memory architecture

Five layers, as specified: Layer 1 (`OrgMemory`, unchanged) — cross-turn
goals/preferences. Layer 2/3 (new `KnowledgeItem`, scope `USER`/
`ORGANIZATION`) — the broader typed store. Layer 4 (`MissionLearning`,
unchanged, plus a new cross-mission read) — mission memory. Layer 5
(system knowledge) — deliberately not seeded; no global public knowledge
base exists to scope against.

## Research architecture

`ResearchProject`/`Query`/`Finding`/`Citation`, a 10-state lifecycle,
URL-driven source discovery (disclosed: no search provider configured),
SSRF-safe fetch reuse, `RESEARCH_CALLS` metering, grounded-or-nothing
synthesis, one `KnowledgeItem` created per completed project with a
conclusion.

## Knowledge architecture

Typed, classified, sourced, evidence-linked, freshness-tracked,
conflict-detected, relation-graphed (relationally, not a graph DB),
governance-gated on the way in from conversation.

## Security changes

Six new RBAC permissions (`knowledge.view/manage`, `memory.view/manage`,
`research.view/run`), following the existing catalog exactly. Every new
model added to `scripts/check-tenant-scope.mjs`'s allowlist (and the one
violation the linter found — a same-org `updateMany` the heuristic
couldn't see was scoped — fixed by adding `organizationId` to the query
explicitly). Fetched web content is always wrapped with `wrapUntrusted`
before reaching a model. No new authorization model.

## UI changes

`/app/knowledge` (overview/detail/new/memories/conflicts), `/app/research`
(list+create/detail), a new "Knowledge" + "Research" nav entry under
Workspace, reusing the Phase 3 design system (`Card`/`Badge`/`PageHeader`/
`EmptyState`/native `<select>` per the established convention — no new
primitive added).

## Tests executed

`pnpm lint` (14/14), `pnpm typecheck` (14/14), `pnpm test` (14/14),
`node scripts/check-tenant-scope.mjs`, `node scripts/audit-allow.mjs`,
`pnpm --filter @growth-agent/web build`.

## Tests passed/failed

All green. **`packages/services` 1348 tests** (+70 over the pre-Phase-11
1278 — including new suites for `knowledge/{schemas,freshness,chunking,
items,conflicts,candidates,retrieval}.test.ts`, `research/engine.test.ts`,
and `agent/context-assembly.test.ts`), plus fixes to two pre-existing
exhaustive-list tests (`agent/tool-registry.test.ts`,
`usage/enforcement.test.ts`) that needed the new tool names/meter added.
Two real shared-test-harness gaps found and fixed while writing this
phase's own tests (see Known limitations below) — both are now permanent
fixes benefiting every future phase's tests, not just this one.

## Environment variables added

None required. `OPENAI_API_KEY` (already a recognized provider key)
enables real embeddings when set; without it, retrieval works via
keyword+metadata only.

## Migration instructions

Standard: `pnpm --filter @growth-agent/db migrate:deploy`. The target
Postgres must support `CREATE EXTENSION vector` (bundled on Supabase and
most managed Postgres) — if it's unavailable, every other statement in
the migration still applies cleanly and every embedding-touching code path
degrades gracefully at runtime (confirmed by test, not just by inspection).

## Known limitations

- **No live verification.** No live OpenAI key, no real Postgres with
  `pgvector` installed, and no live external web content was available in
  this sandbox. Every new module was verified by unit/integration-style
  tests against hand-built fixtures and the shared in-memory DB harness
  only — the same disclosed limitation as every prior phase. The
  pgvector-specific raw-SQL insert/query paths are exercised only via
  their graceful-degradation branch (no model configured), never against a
  real `vector` column.
- **Research is URL-driven, not search-driven**, today — no web-search
  provider is configured in this deployment (Phase 5's own disclosed
  limitation, unchanged); a research project with no seed URLs fails
  honestly rather than fabricating a result.
- **No binary document upload** — text/URL ingestion only; no object
  storage or parsing dependency exists.
- **No mission/knowledge-specific adversarial red-team pass** — the shared
  prompt-injection/instruction-hierarchy machinery is reused unchanged and
  covered by existing tests, matching Phase 10's own disclosed gap.
- **Two shared-test-harness bugs found and fixed in passing**: the shared
  in-memory DB fixture (`testing/memory-db.ts`) had no `orgMemory` model
  stub at all — a real, load-bearing gap `loadMemory` needed, simply never
  added when that harness was built; and its `matchValue` never handled
  Prisma's `{contains/equals, mode: 'insensitive'}` string-filter shape,
  silently matching nothing instead of erroring or working. Both are now
  fixed, permanently, for every future phase's tests.
- **`scripts/check-tenant-scope.mjs` still doesn't cover Phase 10's mission
  models** — noticed while extending its allowlist for this phase's own
  models; not fixed here, out of this phase's scope.

## Production risks

None new beyond what's disclosed above. The `CREATE EXTENSION vector`
migration statement is the one genuinely new deployment dependency this
phase introduces — confirm the target Postgres supports it before
deploying (Supabase does; a bare self-hosted Postgres image may not
without the `pgvector` package installed).

## Recommended next phase

Per the brief's explicit stop condition, no next phase is started
automatically. If continued, the highest-value next steps disclosed above
are: verifying the pgvector paths against a real Postgres instance, adding
a real web-search provider once API-key infrastructure exists, and wiring
the AI SEO Agent (the one domain still not using the Tool Executor per
CLAUDE.md's "Still outstanding" list) through the new Context Assembly
Engine alongside the growth-agent orchestrator.

---

**STOP.** Per the brief's own critical development rule: do not
automatically begin Phase 12, do not implement future-phase functionality
that appears in any roadmap, and do not expand this phase's scope further.
Waiting for explicit instructions.
