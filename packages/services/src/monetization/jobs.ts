/**
 * Monetization job entry point. The scan runs inline in the Server Action
 * (bounded — a few reads + one optional model call); this wrapper resolves the
 * AI provider from env and is available for a scheduled re-scan.
 */
import { createRegistryFromEnv } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { recordAgentRunUsage } from '../usage/ai-sink.js';
import { type RunScanResult, runMonetizationScan } from './analyst.js';

export async function runMonetizationScanJob(
  input: { organizationId: string; userId: string; trigger?: string },
  db: Db = prisma,
): Promise<RunScanResult> {
  let model;
  try {
    model = createRegistryFromEnv().getForRole('analyst').provider;
  } catch {
    model = undefined;
  }
  const result = await runMonetizationScan({ db, model }, input);
  await recordAgentRunUsage(
    { organizationId: input.organizationId, agentRunId: result.agentRunId, actorId: input.userId },
    db,
  );
  return result;
}
