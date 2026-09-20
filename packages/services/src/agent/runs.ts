/**
 * Read-only AgentRun status (Phase 4, Part 47 — `GET /api/agent/runs/:id`).
 * Tenant-scoped: `organizationId` must be the caller's own session context,
 * never taken from the request.
 */
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';

export interface AgentRunView {
  id: string;
  agent: string;
  status: string;
  currentStep: string | null;
  iterationCount: number;
  toolCallCount: number;
  tokensPrompt: number;
  tokensCompletion: number;
  costUsd: string;
  errorCode: string | null;
  error: string | null;
  conversationId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export async function getAgentRun(
  organizationId: string,
  agentRunId: string,
  db: Db = prisma,
): Promise<AgentRunView> {
  const row = await db.agentRun.findFirst({
    where: { id: agentRunId, organizationId },
    select: {
      id: true,
      agent: true,
      status: true,
      currentStep: true,
      iterationCount: true,
      toolCallCount: true,
      tokensPrompt: true,
      tokensCompletion: true,
      costUsd: true,
      errorCode: true,
      error: true,
      conversationId: true,
      startedAt: true,
      finishedAt: true,
      cancelledAt: true,
      createdAt: true,
    },
  });
  if (!row) throw AppError.notFound('Agent run');
  return { ...row, costUsd: row.costUsd.toString() };
}
