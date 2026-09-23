/**
 * Part 31-32: the `ResearchProject` tool surface — distinct names from
 * `research.fetch`/`research.search` (Phase 5, already-registered primitives
 * this module reuses rather than replaces). Creating a project only
 * enqueues work (Part 82 — long research runs off the request path); nothing
 * here fetches a URL directly except through the existing bounded engine.
 */
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { IntegrationToolContext } from '../agent/integration-tools.js';
import { createResearchProject, getResearchProject, listResearchProjects } from './project.js';
import { CreateResearchProjectInput } from './schemas.js';

export const RESEARCH_PROJECT_TOOL_NAMES = [
  'research.project.create',
  'research.project.get',
  'research.project.list',
] as const;
export type ResearchProjectToolName = (typeof RESEARCH_PROJECT_TOOL_NAMES)[number];

interface ResearchProjectTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: ResearchProjectToolName;
  description: string;
  input: I;
  execute(ctx: IntegrationToolContext, input: z.infer<I>): Promise<unknown>;
}

const create: ResearchProjectTool<typeof CreateResearchProjectInput> = {
  name: 'research.project.create',
  description:
    'Start a tracked research project for a question. Runs asynchronously (queued to the worker) and progresses through PLANNING/SEARCHING/COLLECTING/ANALYZING/VERIFYING to COMPLETED/PARTIALLY_COMPLETED/FAILED — poll research.project.get for status. Provide seedUrls in config for sources to fetch; no web-search provider is configured in this deployment, so a project with no seedUrls cannot gather anything external.',
  input: CreateResearchProjectInput,
  async execute(ctx, input) {
    if (!ctx.userId) throw AppError.forbidden('A signed-in user is required to start research.');
    const project = await createResearchProject(input, { organizationId: ctx.organizationId, createdById: ctx.userId }, ctx.db);
    return { id: project.id, status: project.status };
  },
};

const GetInput = z.object({ id: z.string().min(1) });
const get: ResearchProjectTool<typeof GetInput> = {
  name: 'research.project.get',
  description: 'Get a research project\'s full status, findings, and citations.',
  input: GetInput,
  async execute(ctx, input) {
    return getResearchProject(ctx.organizationId, input.id, ctx.db);
  },
};

const ListInput = z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) });
const list: ResearchProjectTool<typeof ListInput> = {
  name: 'research.project.list',
  description: 'List this organization\'s research projects.',
  input: ListInput,
  async execute(ctx, input) {
    return listResearchProjects(ctx.organizationId, input, ctx.db);
  },
};

export const RESEARCH_PROJECT_TOOLS: Record<ResearchProjectToolName, ResearchProjectTool> = {
  'research.project.create': create,
  'research.project.get': get,
  'research.project.list': list,
};

export async function runResearchProjectTool(
  name: string,
  ctx: IntegrationToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const tool = (RESEARCH_PROJECT_TOOLS as Record<string, ResearchProjectTool | undefined>)[name];
  if (!tool) throw AppError.validation(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(`Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return tool.execute(ctx, parsed.data);
}
