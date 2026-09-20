/**
 * Growth Agent job entry points. The chat itself runs inline in a Route Handler
 * (streaming); these wrappers resolve the AI providers from env and are used by
 * the worker for non-interactive turns (e.g. a scheduled "weekly plan").
 */
import { createRegistryFromEnv } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { createAiUsageSink, recordAgentRunUsage } from '../usage/ai-sink.js';
import type { GrowthAgentDeps } from './orchestrator.js';
import { type RunTurnResult, runGrowthAgentTurn } from './orchestrator.js';

export interface GrowthAgentDepsFromEnvOptions {
  db?: Db;
  /**
   * When given, every model call this turn makes — planning, each
   * capability's own sub-agent call, synthesis, response writing — reports
   * usage to the org's AI_REQUESTS/AI_TOKENS billing meters via
   * `createAiUsageSink`, not just the final synthesis call the top-level
   * `AgentRun` row happens to capture (Phase 4 fix — previously the org's
   * billed usage silently under-counted every capability sub-agent call
   * made through the growth-agent orchestrator).
   */
  organizationId?: string;
  actorId?: string | null;
}

/** Build orchestrator deps from env — every model is optional. */
export function growthAgentDepsFromEnv(opts: GrowthAgentDepsFromEnvOptions = {}): GrowthAgentDeps {
  const db = opts.db ?? prisma;
  const sinks = opts.organizationId
    ? [createAiUsageSink({ organizationId: opts.organizationId, actorId: opts.actorId, db })]
    : [];
  const registry = createRegistryFromEnv(sinks);
  try {
    // `analyst` role for planning + capability agents + grounded synthesis;
    // resilience (timeout / retry / provider fallback / kill switch) is baked in
    // by `createRegistryFromEnv`.
    const { provider } = registry.getForRole('analyst');
    return { db, model: provider, responseModel: provider };
  } catch {
    return { db }; // deterministic-only
  }
}

export async function runGrowthAgentTurnJob(
  input: {
    organizationId: string;
    userId: string;
    conversationId?: string;
    message: string;
    trigger?: string;
  },
  db: Db = prisma,
): Promise<RunTurnResult> {
  const result = await runGrowthAgentTurn(
    growthAgentDepsFromEnv({ db, organizationId: input.organizationId, actorId: input.userId }),
    {
      organizationId: input.organizationId,
      userId: input.userId,
      conversationId: input.conversationId,
      message: input.message,
      trigger: input.trigger ?? 'worker',
    },
  );
  // Meter the model usage this turn produced (idempotent on the run id).
  await recordAgentRunUsage(
    { organizationId: input.organizationId, agentRunId: result.agentRunId, actorId: input.userId },
    db,
  );
  return result;
}
