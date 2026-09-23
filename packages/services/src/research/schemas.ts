/** Phase 11 — the research lifecycle's shared types/validation. */
import { z } from 'zod';

export const RESEARCH_STATUSES = [
  'REQUESTED',
  'PLANNING',
  'SEARCHING',
  'COLLECTING',
  'ANALYZING',
  'VERIFYING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

/** Hard ceiling, independent of what the caller asks for — Part 67: "Never
 * allow an autonomous mission to perform unlimited research." */
export const MAX_SOURCES_CEILING = 10;
export const DEFAULT_MAX_SOURCES = 5;

export const CreateResearchProjectInput = z.object({
  question: z.string().min(1).max(2000),
  objective: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  missionId: z.string().min(1).max(80).optional(),
  config: z
    .object({
      /** Public URLs the requester already knows are relevant — with no
       * configured web-search provider (see `research/search.ts`), this is
       * the real source-discovery mechanism today; disclosed, not hidden. */
      seedUrls: z.array(z.string().url()).max(MAX_SOURCES_CEILING).default([]),
      maxSources: z.number().int().min(1).max(MAX_SOURCES_CEILING).default(DEFAULT_MAX_SOURCES),
    })
    .default({}),
});
/** The pre-`.parse()` shape — `config` and its fields stay optional so a
 * caller can omit them and let `createResearchProject` apply the Zod
 * defaults, exactly like a real Server Action call does. */
export type CreateResearchProjectInputT = z.input<typeof CreateResearchProjectInput>;
