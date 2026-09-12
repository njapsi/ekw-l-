/**
 * Bridges the AI layer's `UsageSink` to metering. Pass the sink to
 * `createRegistryFromEnv([sink])` (or `registry.addUsageSink(...)`) so every
 * model call records `AI_REQUESTS` (+1) and `AI_TOKENS` (+prompt+completion)
 * for the org, with the AgentRun / request id as the idempotency subject.
 *
 * Recording never blocks or fails the AI call: a metering error is logged and
 * swallowed (the model work already happened).
 */
import type { UsageRecord, UsageSink } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordUsage } from './record.js';

const log = createLogger('usage.ai-sink');

export interface AiSinkOptions {
  organizationId: string;
  actorId?: string | null;
  /** Correlates the records and dedupes retries — an AgentRun id, request id, … */
  context?: string;
  db?: Db;
}

export function createAiUsageSink(opts: AiSinkOptions): UsageSink {
  const db = opts.db ?? prisma;
  let seq = 0;
  return {
    async record(usage: UsageRecord): Promise<void> {
      const ctx = usage.context ?? opts.context ?? `ai_${Date.now()}`;
      const n = seq++;
      try {
        await recordUsage(
          {
            organizationId: opts.organizationId,
            meter: 'AI_REQUESTS',
            quantity: 1,
            idempotencyKey: `ai_req:${opts.organizationId}:${ctx}:${n}`,
            actorId: opts.actorId ?? null,
            subjectType: 'ai_call',
            subjectId: ctx,
            costUsd: usage.estimatedCostUsd,
            metadata: { provider: usage.provider, model: usage.model },
          },
          db,
        );
        const tokens = usage.totalTokens || usage.promptTokens + usage.completionTokens;
        if (tokens > 0) {
          await recordUsage(
            {
              organizationId: opts.organizationId,
              meter: 'AI_TOKENS',
              quantity: tokens,
              idempotencyKey: `ai_tok:${opts.organizationId}:${ctx}:${n}`,
              actorId: opts.actorId ?? null,
              subjectType: 'ai_call',
              subjectId: ctx,
              costUsd: usage.estimatedCostUsd,
              metadata: {
                provider: usage.provider,
                model: usage.model,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
              },
            },
            db,
          );
        }
      } catch (err) {
        log.error({ err, organizationId: opts.organizationId }, 'failed to record AI usage');
      }
    },
  };
}

/**
 * Record AI usage for a completed `AgentRun` (used by the job / Server Action
 * layer, which has the org + run id but does not thread a live sink into the
 * agent). Reads the run's token counts and records `AI_REQUESTS` (+1) and
 * `AI_TOKENS` (+prompt+completion). Idempotent on the run id — safe to call
 * from every code path that produced the run.
 */
export async function recordAgentRunUsage(
  input: {
    organizationId: string;
    agentRunId: string;
    actorId?: string | null;
  },
  db: Db = prisma,
): Promise<void> {
  let run: {
    organizationId: string;
    tokensPrompt: number;
    tokensCompletion: number;
    costUsd: unknown;
  } | null = null;
  try {
    run = await db.agentRun.findUnique({
      where: { id: input.agentRunId },
      select: { organizationId: true, tokensPrompt: true, tokensCompletion: true, costUsd: true },
    });
  } catch (err) {
    log.error({ err, agentRunId: input.agentRunId }, 'failed to load agent run for metering');
    return;
  }
  if (!run || run.organizationId !== input.organizationId) return;

  const costUsd = run.costUsd == null ? undefined : Number(run.costUsd);
  const tokens = Math.max(0, run.tokensPrompt) + Math.max(0, run.tokensCompletion);
  try {
    await recordUsage(
      {
        organizationId: input.organizationId,
        meter: 'AI_REQUESTS',
        quantity: 1,
        idempotencyKey: `ai_req:run:${input.agentRunId}`,
        actorId: input.actorId ?? null,
        subjectType: 'agent_run',
        subjectId: input.agentRunId,
        costUsd,
      },
      db,
    );
    if (tokens > 0) {
      await recordUsage(
        {
          organizationId: input.organizationId,
          meter: 'AI_TOKENS',
          quantity: tokens,
          idempotencyKey: `ai_tok:run:${input.agentRunId}`,
          actorId: input.actorId ?? null,
          subjectType: 'agent_run',
          subjectId: input.agentRunId,
          costUsd,
        },
        db,
      );
    }
  } catch (err) {
    log.error({ err, agentRunId: input.agentRunId }, 'failed to record agent-run usage');
  }
}
