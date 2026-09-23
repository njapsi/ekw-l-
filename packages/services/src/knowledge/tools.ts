/**
 * Part 31-32: the knowledge/memory/evidence tool surface for the agent
 * runtime, dispatched through the existing Phase 5 Tool Executor
 * (`agent/tool-executor.ts`'s `kindOf`/dispatch gains a `'knowledge'` case —
 * see that file). Every tool here is READ or a bounded, low-risk write
 * against the org's OWN stored knowledge — none of it touches an external
 * system, so none needs governance/approval gating the way an integration
 * tool does. `knowledge.create`/`update` still run through the same
 * `createKnowledgeItem`/`updateKnowledgeItem` validation and audit trail a
 * human editing the Knowledge Center UI would.
 *
 * This intentionally does not re-implement `research.fetch`/`research.search`
 * (Phase 5, `research/tools.ts`) — those names are already taken and their
 * tools already exist; this file's research tools are namespaced
 * `research.project.*` for the new, persistent `ResearchProject` lifecycle.
 */
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { IntegrationToolContext } from '../agent/integration-tools.js';
import {
  archiveKnowledgeItem,
  createKnowledgeItem,
  getKnowledgeItem,
  updateKnowledgeItem,
} from './items.js';
import { retrieveKnowledge } from './retrieval.js';
import { searchEvidence, getEvidence } from './evidence.js';
import { proposeMemoryCandidate, listMemoryCandidates } from './candidates.js';
import { CreateKnowledgeItemInput, KNOWLEDGE_STATUSES, KNOWLEDGE_TYPES } from './schemas.js';
import type { EmbeddingCapableModel } from './embeddings.js';

export interface KnowledgeToolContext extends IntegrationToolContext {
  model?: EmbeddingCapableModel;
}

export const KNOWLEDGE_TOOL_NAMES = [
  'knowledge.search',
  'knowledge.get',
  'knowledge.create',
  'knowledge.update',
  'knowledge.archive',
  'memory.propose',
  'memory.search',
  'evidence.search',
  'evidence.get',
] as const;
export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

interface KnowledgeTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: KnowledgeToolName;
  description: string;
  input: I;
  execute(ctx: KnowledgeToolContext, input: z.infer<I>): Promise<unknown>;
}

const SearchInput = z.object({
  query: z.string().max(500).default(''),
  types: z.array(z.enum(KNOWLEDGE_TYPES)).optional(),
  limit: z.number().int().min(1).max(30).default(10),
});
const knowledgeSearch: KnowledgeTool<typeof SearchInput> = {
  name: 'knowledge.search',
  description:
    'Search this organization\'s stored knowledge (business profile, brand, audience, strategy, research, learnings, …) by keyword and semantic relevance. Returns each item\'s classification (fact/inference/hypothesis/…) and confidence — never treat a hypothesis as a fact.',
  input: SearchInput,
  async execute(ctx, input) {
    const results = await retrieveKnowledge(
      ctx.organizationId,
      input.query,
      { types: input.types, limit: input.limit },
      ctx.model,
      ctx.db,
    );
    return results;
  },
};

const GetInput = z.object({ id: z.string().min(1) });
const knowledgeGet: KnowledgeTool<typeof GetInput> = {
  name: 'knowledge.get',
  description: 'Fetch one knowledge item in full, including its evidence and source.',
  input: GetInput,
  async execute(ctx, input) {
    return getKnowledgeItem(ctx.organizationId, input.id, ctx.db);
  },
};

const knowledgeCreate: KnowledgeTool<typeof CreateKnowledgeItemInput> = {
  name: 'knowledge.create',
  description:
    'Record a new knowledge item about this organization (a fact, inference, or hypothesis). Starts as DRAFT/UNVERIFIED unless directly user-provided — never mark something VERIFIED without real evidence.',
  input: CreateKnowledgeItemInput,
  async execute(ctx, input) {
    const item = await createKnowledgeItem(input, { organizationId: ctx.organizationId, createdById: ctx.userId }, ctx.db);
    return { id: item.id, status: item.status };
  },
};

const UpdateInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(20_000).optional(),
  summary: z.string().max(600).optional(),
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
});
const knowledgeUpdate: KnowledgeTool<typeof UpdateInput> = {
  name: 'knowledge.update',
  description: 'Update an existing knowledge item this organization owns.',
  input: UpdateInput,
  async execute(ctx, input) {
    const { id, ...rest } = input;
    const item = await updateKnowledgeItem(ctx.organizationId, id, rest, ctx.userId, ctx.db);
    return { id: item.id, status: item.status };
  },
};

const ArchiveInput = z.object({ id: z.string().min(1) });
const knowledgeArchive: KnowledgeTool<typeof ArchiveInput> = {
  name: 'knowledge.archive',
  description: 'Archive a knowledge item that is no longer relevant.',
  input: ArchiveInput,
  async execute(ctx, input) {
    const item = await archiveKnowledgeItem(ctx.organizationId, input.id, ctx.userId, ctx.db);
    return { id: item.id, status: item.status };
  },
};

const ProposeInput = z.object({
  content: z.string().min(1).max(4000),
  proposedType: z.enum(KNOWLEDGE_TYPES),
  reason: z.string().min(1).max(500),
  importance: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  confidence: z.number().min(0).max(1).default(0.6),
});
const memoryPropose: KnowledgeTool<typeof ProposeInput> = {
  name: 'memory.propose',
  description:
    'Propose something worth remembering about this organization for later use. This does NOT save it immediately — it creates a candidate a human (or, for low-stakes high-confidence cases, an automatic safe-accept rule) reviews before it becomes real knowledge.',
  input: ProposeInput,
  async execute(ctx, input) {
    const candidate = await proposeMemoryCandidate(
      { organizationId: ctx.organizationId, userId: ctx.userId, ...input },
      ctx.db,
    );
    return { id: candidate.id, status: candidate.status };
  },
};

const MemorySearchInput = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_ACCEPTED', 'SUPERSEDED']).default('PENDING'),
});
const memorySearch: KnowledgeTool<typeof MemorySearchInput> = {
  name: 'memory.search',
  description: 'List memory candidates awaiting review (or already resolved) for this organization.',
  input: MemorySearchInput,
  async execute(ctx, input) {
    return listMemoryCandidates(ctx.organizationId, input.status, ctx.db);
  },
};

const EvidenceSearchInput = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(30).default(10) });
const evidenceSearch: KnowledgeTool<typeof EvidenceSearchInput> = {
  name: 'evidence.search',
  description: 'Search recorded evidence (claim + supporting source excerpt) by keyword.',
  input: EvidenceSearchInput,
  async execute(ctx, input) {
    return searchEvidence(ctx.organizationId, input.query, input.limit, ctx.db);
  },
};

const EvidenceGetInput = z.object({ id: z.string().min(1) });
const evidenceGet: KnowledgeTool<typeof EvidenceGetInput> = {
  name: 'evidence.get',
  description: 'Fetch one evidence record with its source.',
  input: EvidenceGetInput,
  async execute(ctx, input) {
    return getEvidence(ctx.organizationId, input.id, ctx.db);
  },
};

export const KNOWLEDGE_TOOLS: Record<KnowledgeToolName, KnowledgeTool> = {
  'knowledge.search': knowledgeSearch,
  'knowledge.get': knowledgeGet,
  'knowledge.create': knowledgeCreate,
  'knowledge.update': knowledgeUpdate,
  'knowledge.archive': knowledgeArchive,
  'memory.propose': memoryPropose,
  'memory.search': memorySearch,
  'evidence.search': evidenceSearch,
  'evidence.get': evidenceGet,
};

export async function runKnowledgeTool(
  name: string,
  ctx: KnowledgeToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const tool = (KNOWLEDGE_TOOLS as Record<string, KnowledgeTool | undefined>)[name];
  if (!tool) throw AppError.validation(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(`Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return tool.execute(ctx, parsed.data);
}
