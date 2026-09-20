/**
 * The research tool surface (Phase 5, Part 41). Two tools, both READ-only —
 * there is no `research.execute` / `research.browse` and never will be
 * (Part 41's own explicit prohibition). Output from either tool is
 * untrusted external content: the caller must wrap it with `wrapUntrusted`
 * before it reaches a model prompt, exactly like every other agent tool
 * that returns third-party text.
 */
import { z } from 'zod';
import { AppError } from '../errors.js';
import { researchFetch } from './fetch.js';
import { runSearch } from './search.js';

export const RESEARCH_TOOL_NAMES = ['research.fetch', 'research.search'] as const;
export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];

interface ResearchTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: ResearchToolName;
  description: string;
  input: I;
  execute(input: z.infer<I>): Promise<unknown>;
}

const FetchInput = z.object({ url: z.string().url().max(2_000) });
const fetchTool: ResearchTool<typeof FetchInput> = {
  name: 'research.fetch',
  description:
    'Fetch one public web page and return a citation (source URL, title, retrieval time, a text excerpt, a content hash). SSRF-protected — private/internal network addresses are always refused.',
  input: FetchInput,
  async execute(input) {
    return researchFetch(input.url);
  },
};

const SearchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5),
});
const searchTool: ResearchTool<typeof SearchInput> = {
  name: 'research.search',
  description:
    'Web search. Returns { available: false } with a plain reason when no search provider is configured for this deployment — never fabricated results.',
  input: SearchInput,
  async execute(input) {
    return runSearch(input.query, input.limit);
  },
};

export const RESEARCH_TOOLS: Record<ResearchToolName, ResearchTool> = {
  'research.fetch': fetchTool,
  'research.search': searchTool,
};

export async function runResearchTool(name: string, rawInput: unknown): Promise<unknown> {
  const tool = (RESEARCH_TOOLS as Record<string, ResearchTool | undefined>)[name];
  if (!tool) throw AppError.validation(`Unknown tool "${name}".`);
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      `Invalid input for ${name}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  return tool.execute(parsed.data);
}
