/**
 * Phase 11, Part 28-30, 87: the Context Assembly Engine. A single place that
 * composes everything an agent turn or a mission plan should consider —
 * connected-platform state, cross-turn memory, stored organizational
 * knowledge, recent research, and cross-mission learnings — so no capability
 * or planner builds its own ad hoc mash-up of these sources (Part 28: "Do
 * not allow each agent to build context independently").
 *
 * This does NOT replace `context.ts::loadOrgContext` or
 * `memory.ts::loadMemory` — both are reused as-is; this module is the layer
 * *above* them that adds knowledge/research/learning and applies a context
 * budget (Part 30) before anything reaches a prompt.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { loadOrgContext, type OrgContext } from './context.js';
import { loadMemory, type AgentMemory } from './memory.js';
import { retrieveKnowledge, type RetrievedKnowledge } from '../knowledge/retrieval.js';
import type { EmbeddingCapableModel } from '../knowledge/embeddings.js';
import { listRecentLearnings } from '../missions/learning.js';

const log = createLogger('agent.context-assembly');

export interface RecentResearchSummary {
  id: string;
  question: string;
  status: string;
  conclusion: string | null;
  confidence: number | null;
}

export interface RecentLearningSummary {
  type: string;
  title: string;
  detail: string;
  confidence: number;
  missionName: string | null;
}

/**
 * Part 87's `AgentContext` contract. `identity`/`permissions` are
 * deliberately NOT re-resolved here — those are the session/RBAC layer's job
 * (`apps/web/src/lib/auth.ts`, `rbac/index.ts`), and duplicating that
 * resolution here would be a second authorization path (Part 84's explicit
 * boundary: Auth → RBAC → Tenant Scope → Agent Runtime, never the other way
 * around). This module only ever receives an already-authorized
 * `organizationId`/`userId`.
 */
export interface AgentContext {
  organizationId: string;
  userId: string;
  /** The current turn's message, or a mission's objective — whatever the
   * caller is trying to accomplish right now. */
  goal: string;
  mission: { id: string; name: string; objective: string; status: string } | null;
  preferences: string[];
  goals: string[];
  currentData: OrgContext;
  relevantKnowledge: RetrievedKnowledge[];
  relevantMemory: AgentMemory;
  recentResearch: RecentResearchSummary[];
  historicalLearning: RecentLearningSummary[];
  /** Human-readable labels of what was actually used, for the chat UI's
   * "Used: • Your business profile • Previous YouTube experiments" (Part 44)
   * — never the raw prompt or chain-of-thought. */
  usedSources: string[];
}

export interface AssembleContextInput {
  organizationId: string;
  userId: string;
  goal: string;
  missionId?: string;
  model?: EmbeddingCapableModel;
  /** Context-budget caps (Part 30) — small for a chat turn, larger for a
   * mission plan that only runs occasionally. */
  knowledgeLimit?: number;
  learningLimit?: number;
  researchLimit?: number;
}

export async function assembleAgentContext(
  input: AssembleContextInput,
  db: Db = prisma,
): Promise<AgentContext> {
  const [orgContext, memory, mission] = await Promise.all([
    loadOrgContext(input.organizationId, db),
    loadMemory(input.organizationId, input.userId, db),
    input.missionId
      ? db.growthMission.findFirst({
          where: { id: input.missionId, organizationId: input.organizationId },
          select: { id: true, name: true, objective: true, status: true },
        })
      : Promise.resolve(null),
  ]);

  // Each of these three reads is an enhancement on top of the turn loop that
  // worked before Phase 11 — a failure here (an environment mid-migration, a
  // transient DB hiccup) degrades to "no extra context" rather than failing
  // the whole turn, matching every capability's own `needs_prerequisite`/
  // `error` degrade-gracefully convention (`capabilities.ts`).
  const [relevantKnowledge, recentResearchRows, learningRows] = await Promise.all([
    retrieveKnowledge(
      input.organizationId,
      input.goal,
      { missionId: input.missionId, limit: input.knowledgeLimit ?? 8 },
      input.model,
      db,
    ).catch((e: unknown) => {
      log.warn({ organizationId: input.organizationId, err: String(e) }, 'knowledge retrieval failed');
      return [] as RetrievedKnowledge[];
    }),
    // Wrapped in an async IIFE (not chained directly onto `db.researchProject`)
    // so a fixture/environment where that model doesn't exist at all throws
    // *into* a promise `.catch()` can actually attach to, rather than
    // synchronously during this array's construction — which would abort
    // the whole `Promise.all` before any `.catch()` was ever attached.
    (async () =>
      db.researchProject.findMany({
        where: { organizationId: input.organizationId, status: { in: ['COMPLETED', 'PARTIALLY_COMPLETED'] } },
        orderBy: { completedAt: 'desc' },
        take: input.researchLimit ?? 3,
        select: { id: true, question: true, status: true, conclusion: true, confidence: true },
      }))().catch((e: unknown) => {
      log.warn({ organizationId: input.organizationId, err: String(e) }, 'recent research lookup failed');
      return [] as RecentResearchSummary[];
    }),
    listRecentLearnings(
      input.organizationId,
      { limit: input.learningLimit ?? 8, excludeMissionId: input.missionId },
      db,
    ).catch((e: unknown) => {
      log.warn({ organizationId: input.organizationId, err: String(e) }, 'recent learnings lookup failed');
      return [];
    }),
  ]);

  const usedSources: string[] = [];
  if (relevantKnowledge.length > 0) usedSources.push('Your stored business knowledge');
  if (memory.userGoals.length + memory.orgGoals.length > 0) usedSources.push('Your goals and preferences');
  if (recentResearchRows.length > 0) usedSources.push('Prior research');
  if (learningRows.length > 0) usedSources.push('Lessons from previous missions');
  if (orgContext.youtube.connected) usedSources.push('Your connected YouTube data');
  if (orgContext.tiktok.connected) usedSources.push('Your connected TikTok data');
  if (orgContext.seo.websites > 0) usedSources.push('Your website/SEO data');

  return {
    organizationId: input.organizationId,
    userId: input.userId,
    goal: input.goal,
    mission,
    preferences: memory.preferences,
    goals: [...memory.userGoals, ...memory.orgGoals],
    currentData: orgContext,
    relevantKnowledge,
    relevantMemory: memory,
    recentResearch: recentResearchRows,
    historicalLearning: learningRows.map((l) => ({
      type: l.type,
      title: l.title,
      detail: l.detail,
      confidence: l.confidence,
      missionName: l.mission?.name ?? null,
    })),
    usedSources,
  };
}

/** Renders the assembled context into a compact prompt block, respecting a
 * character budget (Part 30 — never the entire knowledge base). Every line
 * is prefixed with its classification so the model can't mistake a
 * hypothesis for a verified fact (Part 5). */
export function summarizeAgentContext(ctx: AgentContext, maxChars = 3000): string {
  const lines: string[] = [];
  if (ctx.mission) {
    lines.push(`MISSION: ${ctx.mission.name} (${ctx.mission.status}) — ${ctx.mission.objective}`);
  }
  if (ctx.preferences.length) lines.push(`PREFERENCES: ${ctx.preferences.join('; ')}`);
  for (const k of ctx.relevantKnowledge) {
    lines.push(`[${k.classification}, confidence ${k.confidence.toFixed(2)}] ${k.title}: ${k.summary ?? k.content.slice(0, 200)}`);
  }
  for (const r of ctx.recentResearch) {
    if (r.conclusion) lines.push(`[RESEARCH, confidence ${(r.confidence ?? 0).toFixed(2)}] ${r.question}: ${r.conclusion}`);
  }
  for (const l of ctx.historicalLearning) {
    lines.push(`[${l.type}${l.missionName ? `, ${l.missionName}` : ''}] ${l.title}: ${l.detail.slice(0, 200)}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
