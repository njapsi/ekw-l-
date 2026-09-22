/**
 * Durable per-mission timeline (Phase 10, §25/§42), mirroring
 * `agent/events.ts`'s exact "one row per real transition" design —
 * `recordMissionEvent` never throws into the caller, and metadata is
 * scrubbed exactly like model output before it is stored.
 */
import { type Db, type Prisma, prisma } from '@growth-agent/db';
import { scrubModelOutput } from '../agents/output-scrub.js';

export type MissionEventType =
  | 'MISSION_CREATED'
  | 'PLAN_GENERATED'
  | 'MISSION_ACTIVATED'
  | 'MILESTONE_STARTED'
  | 'MILESTONE_COMPLETED'
  | 'TASK_CREATED'
  | 'TASK_READY'
  | 'TASK_STARTED'
  | 'TASK_SUCCEEDED'
  | 'TASK_FAILED'
  | 'TASK_BLOCKED'
  | 'TASK_SKIPPED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_REJECTED'
  | 'METRIC_UPDATED'
  | 'LEARNING_RECORDED'
  | 'REPLAN_TRIGGERED'
  | 'MISSION_PAUSED'
  | 'MISSION_RESUMED'
  | 'MISSION_BLOCKED'
  | 'MISSION_COMPLETED'
  | 'MISSION_FAILED'
  | 'MISSION_CANCELLED'
  | 'LIMIT_REACHED'
  | 'CONFLICT_DETECTED'
  | 'NOTIFICATION_SENT';

export async function recordMissionEvent(
  input: {
    missionId: string;
    organizationId: string;
    type: MissionEventType;
    metadata?: Record<string, unknown>;
  },
  db: Db = prisma,
): Promise<void> {
  try {
    await db.missionEvent.create({
      data: {
        missionId: input.missionId,
        organizationId: input.organizationId,
        type: input.type,
        metadata: input.metadata
          ? (scrubModelOutput(input.metadata) as Prisma.InputJsonValue)
          : undefined,
      },
    });
  } catch {
    // Diagnostic timeline only — a write failure must never break the
    // mission loop step it's recording (same convention as `recordAudit`).
  }
}

export interface MissionEventView {
  id: string;
  type: MissionEventType;
  metadata: unknown;
  createdAt: Date;
}

export async function listMissionEvents(
  organizationId: string,
  missionId: string,
  db: Db = prisma,
): Promise<MissionEventView[]> {
  const rows = await db.missionEvent.findMany({
    where: { missionId, organizationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, metadata: true, createdAt: true },
  });
  return rows;
}
