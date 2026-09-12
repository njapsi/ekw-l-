# AI-PRODUCTION-AUDIT.md

Phase 22 — production audit of the AI layer. Status per the phase brief's
headings: **verified** = already correct, checked against source;
**hardened** = changed this phase. See `docs/AI-ARCHITECTURE.md` for the full
design and `docs/DECISIONS.md` ADR-0037 for the rationale.

---

## 1. Model abstraction

| Control             | Status   | Where                                                                                                                                                                                                                                              |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider interface  | verified | `packages/ai/src/types.ts` `AIProvider` (`generateText` / `generateObject` / `streamText` / optional `embed`); `VercelAIProvider` adapts any Vercel-AI-SDK model; `anthropic` / `openai` / `google` factories                                      |
| Model configuration | hardened | `ModelRef { provider, model }` per call (existing) + **role map** `packages/ai/src/roles.ts` `modelForRole('router'\|'analyst'\|'long_context'\|'embedding')` from `AI_MODEL_<ROLE>` env; `registry.getForRole(...)`                               |
| Fallback behavior   | hardened | `AI_FALLBACK_MODELS` → `FallbackProvider` (`packages/ai/src/fallback.ts`); `registry.get()` returns head + tail chain; advances on any thrown error; `streamText` = initial-connection only; every analyst also has a deterministic non-model path |
| Timeouts            | hardened | `withResilience` (`packages/ai/src/resilient.ts`) — `AI_REQUEST_TIMEOUT_MS` (60 s default), `AbortController`, `AiTimeoutError`, one timeout retry                                                                                                 |
| Retry logic         | hardened | transient 429/5xx/network → `AI_MAX_RETRIES` (default 2), configured once and executed by the provider SDK (`VercelAIProvider.retries()`); the wrapper does not double-retry                                                                       |
| Usage tracking      | verified | `UsageRecord` from every call; `createAiUsageSink` → `AI_REQUESTS` / `AI_TOKENS` meters; `recordAgentRunUsage` from the job/route layer; idempotent                                                                                                |
| Cost tracking       | verified | `pricing.ts` per-model price table → `estimatedCostUsd` on every `UsageRecord`; `costUsd` persisted on every `AgentRun`; unknown model = 0 **and** `isKnownModel` flag for the caller                                                              |

Kill switch (`AI_DISABLED`, `AI_DISABLED_PROVIDERS`) is new this phase, checked
per call so an operator flips it without a redeploy.

## 2. Structured output

**Verified.** Every critical AI operation calls `generateObject(schema)` with a
Zod schema and validates before use:

| Operation                              | Schema                                                  | Post-validation                                                                                                 |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| YouTube analyst                        | `YouTubeAnalysis`                                       | `checkGrounding` (fact-id + number + guarantee), 1 repair, then run `FAILED`                                    |
| TikTok analyst                         | `TikTokAnalysis`                                        | same shared grounding guard                                                                                     |
| SEO agent                              | `SeoAgentModelOutput`                                   | `checkGroundingFields`, 1 repair, else deterministic templates (numbers never depend on the model)              |
| SEO auditor                            | `CrawlAuditAnalysis`                                    | grounding guard, deterministic minimal summary on failure                                                       |
| Monetization analyst                   | `MonetizationAnalysis`                                  | grounding guard → deterministic prose on any failure; never emits numbers                                       |
| Content analyst / generator            | `ContentAnalysis` / per-deliverable schemas             | verbatim-quote check + `GUARANTEE_RE` → deterministic template                                                  |
| Growth Agent plan / synthesis / memory | `TurnPlan` / `GrowthAgentResponse` / `MemoryExtraction` | keyword-plan fallback; `checkGroundingFields` → deterministic assembly; memory re-validated by the write guards |

No code path uses free-text model output where a schema is expected. No
`thinking` / chain-of-thought field is ever surfaced.

## 3. Agents — restricted tools

**Verified** (see `docs/AGENTS.md` "Restricted tools — verification"). Only
`seo-agent` and `growth-agent` have a tool surface, both read-only and
org-scoped from context; the six analysts have **no tool loop**. No agent holds
a raw DB client, a write/publish/delete tool, or an HTTP fetch. `content` and
`tiktok` publishing run through their own explicit-approval Server Action.

## 4. AI cost control

| Control                | Status              | Where                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-organization limit | verified            | `usage.enforceUsage({ meter: 'AI_REQUESTS' })` server-side before every turn (agent-stream route, growth-agent job, content/monetization actions)                                                                                                                    |
| Per-user limit         | hardened            | `usage.enforceAiUserLimit({ organizationId, userId, scope })` — fixed-window Redis, `AI_USER_RATE_LIMIT` / `AI_USER_RATE_WINDOW_SEC` (30/60 s), fail-open; wired into the agent-stream route + SEO-agent / content / monetization / YouTube / TikTok analyst actions |
| Token tracking         | verified            | `AI_TOKENS` meter (prompt + completion), `tokensPrompt` / `tokensCompletion` on `AgentRun`                                                                                                                                                                           |
| Request tracking       | verified            | `AI_REQUESTS` meter (+1 per call / run), `subjectType: 'ai_call'` / `'agent_run'`                                                                                                                                                                                    |
| Cost estimates         | verified            | `pricing.ts`; `costUsd` on `UsageRecord` + `AgentRun` + `UsageRecord` metadata                                                                                                                                                                                       |
| Rate limits            | verified + hardened | route-level `checkRateLimit` (existing) + the new per-user AI throttle                                                                                                                                                                                               |

## 5. Prompt injection

**Hardened.** Treated as untrusted and fenced with `wrapUntrusted` + the
standing `UNTRUSTED_CONTENT_SYSTEM_CLAUSE` on the system prompt:

| Source                                                           | Label                                                                | File                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Website / crawl content                                          | (structured derivatives only; `USER_QUESTION` / `USER_GOALS` fenced) | `seo/agent.ts`                                                 |
| YouTube video titles / tags / descriptions                       | `YOUTUBE_VIDEO_METADATA`                                             | `youtube/analyst.ts`                                           |
| TikTok captions / hashtags                                       | `TIKTOK_VIDEO_METADATA`                                              | `tiktok/analyst.ts`                                            |
| User-provided documents / brief                                  | `SOURCE_CONTENT`, `CONTENT_ANALYSIS`                                 | `content/analyze.ts`, `content/generate.ts`                    |
| Business-profile free text                                       | `MONETIZATION_SIGNALS`                                               | `monetization/analyst.ts`                                      |
| Chat message + history + capability evidence (external API text) | `USER_MESSAGE`, `CHAT_HISTORY`, `CAPABILITY_EVIDENCE`                | `agent/planner.ts`, `agent/orchestrator.ts`, `agent/memory.ts` |

External content can never change tool authorization, tenant scope, budgets, or
approval state — the tool registries are read-only and org-scoped from context.
`checkGroundingFields` runs after the model as the second line.

## 6. AI actions

**Verified.** The Growth Agent orchestrator emits external-system actions
(publish, metadata changes) as proposals with `requiresConfirmation` and
**never executes them** (ADR-0022); the user completes them through the owning
feature's approval screen. Content-repurposing `markAssetPublished` is a status
marker only. TikTok publishing requires an explicit approved action with a
duplicate-publish guard. No agent deletes data.

## 7. Adversarial tests

**Added.** `packages/services/src/agents/adversarial.test.ts` — prompt
injection, malicious website/content, fabricated analytics, conflicting data,
missing data, invalid tool calls (see `docs/AI-ARCHITECTURE.md` §8).
`packages/ai/src/{resilient,fallback,roles}.test.ts` — timeout, retry, kill
switch, provider fallback, role resolution.
`packages/services/src/usage/ai-limit.test.ts` — per-user throttle incl.
fail-open.

---

## Residual risk

- Real cross-provider failover, the live timeout path, and true provider 429/5xx
  retry are exercised only through fakes + injected errors locally — a manual
  smoke with a real key closes the loop (`AI_REQUEST_TIMEOUT_MS=1`;
  `AI_FALLBACK_MODELS=openai:gpt-4o-mini` with a broken `ANTHROPIC_API_KEY`).
- `streamText` fallback covers the initial connection only; a mid-stream
  provider failure falls back to the deterministic reply, not another provider.
- The per-user throttle is fail-open by design; a Redis outage removes that
  layer but the per-org monthly hard cap (`enforceUsage`) still holds.
- Model-id defaults (`claude-sonnet-4-5`) are unchanged; the role map makes them
  fully env-configurable but a stale default is still a config task.
