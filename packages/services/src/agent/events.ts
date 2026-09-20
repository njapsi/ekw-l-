/**
 * Durable per-step AgentRun timeline (Phase 4, Part 3).
 *
 * Independent of the live SSE stream (`TurnEvent` in orchestrator.ts, which
 * is ephemeral — nothing before this phase persisted it). Every event here
 * is written after the fact, from the orchestrator's own control flow, and
 * scrubbed exactly like model output before it is stored: metadata must
 * never carry an OAuth token, refresh token, password or API key.
 */
import { type Db, type Prisma, prisma } from '@growth-agent/db';
import { scrubModelOutput } from '../agents/output-scrub.js';

export type AgentRunEventType =
  | 'RUN_CREATED'
  | 'RUN_STARTED'
  | 'CONTEXT_LOADED'
  | 'PLAN_CREATED'
  | 'MODEL_CALLED'
  | 'MODEL_RESPONSE'
  | 'TOOL_SELECTED'
  | 'TOOL_AUTHORIZATION_CHECK'
  | 'TOOL_STARTED'
  | 'TOOL_COMPLETED'
  | 'TOOL_FAILED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_REJECTED'
  | 'USER_INPUT_REQUESTED'
  | 'USER_INPUT_RECEIVED'
  | 'MEMORY_UPDATED'
  | 'RETRY_STARTED'
  | 'RUN_PAUSED'
  | 'RUN_RESUMED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'RUN_CANCELLED';

/** Never throws into the caller — an event-write failure must not break the
 * turn it's recording, matching this codebase's `recordAudit` convention. */
export async function recordAgentRunEvent(
  input: {
    agentRunId: string;
    organizationId: string;
    type: AgentRunEventType;
    metadata?: Record<string, unknown>;
  },
  db: Db = prisma,
): Promise<void> {
  try {
    await db.agentRunEvent.create({
      data: {
        agentRunId: input.agentRunId,
        organizationId: input.organizationId,
        type: input.type,
        metadata: input.metadata
          ? (scrubModelOutput(input.metadata) as Prisma.InputJsonValue)
          : undefined,
      },
    });
  } catch {
    // Logging here would need the shared logger imported into a very
    // low-level module; the timeline is a diagnostic aid, not part of the
    // turn's correctness, so a write failure is silently dropped rather
    // than risking a logging dependency cycle.
  }
}

export interface AgentRunEventView {
  id: string;
  type: AgentRunEventType;
  metadata: unknown;
  createdAt: Date;
}

/** Tenant-scoped: `organizationId` must be the caller's own, taken from the
 * session — never from request input. */
export async function listAgentRunEvents(
  organizationId: string,
  agentRunId: string,
  db: Db = prisma,
): Promise<AgentRunEventView[]> {
  const rows = await db.agentRunEvent.findMany({
    where: { agentRunId, organizationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, metadata: true, createdAt: true },
  });
  return rows;
}
