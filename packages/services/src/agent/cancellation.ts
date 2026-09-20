/**
 * Interactive agent-run cancellation (Phase 4, Part 20).
 *
 * The orchestrator itself only ever *observes* CANCELLED between stage
 * checkpoints (`checkCancelled` in orchestrator.ts) — this is the only
 * function that ever sets it for a chat-triggered run, via a conditional
 * `updateMany` that succeeds only from QUEUED/RUNNING, the same
 * exactly-once pattern `approvals/index.ts` uses for approval decisions.
 */
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import { recordAgentRunEvent } from './events.js';

export async function cancelAgentRun(
  input: { organizationId: string; userId: string; agentRunId: string },
  db: Db = prisma,
): Promise<{ cancelled: boolean }> {
  const run = await db.agentRun.findFirst({
    where: { id: input.agentRunId, organizationId: input.organizationId },
    select: { id: true, userId: true, status: true },
  });
  if (!run) throw AppError.notFound('Agent run');
  // Only the run's own user (or a future admin override) may stop it — never
  // trusted from anything the client sends beyond identity.
  if (run.userId && run.userId !== input.userId) {
    throw AppError.forbidden('You can only cancel your own agent run.');
  }

  const claimed = await db.agentRun.updateMany({
    where: {
      id: input.agentRunId,
      organizationId: input.organizationId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      finishedAt: new Date(),
      currentStep: 'done',
    },
  });
  if (claimed.count === 0) {
    // Already finished/failed/cancelled — nothing to do, and not an error:
    // the caller asked to stop a run that's already stopped.
    return { cancelled: false };
  }
  await recordAgentRunEvent(
    {
      agentRunId: input.agentRunId,
      organizationId: input.organizationId,
      type: 'RUN_CANCELLED',
      metadata: { requestedBy: input.userId },
    },
    db,
  );
  return { cancelled: true };
}
