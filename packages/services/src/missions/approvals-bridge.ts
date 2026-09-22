/**
 * Mission ↔ approval-queue bridge (Phase 10, §16/§26). A mission never gets
 * its own approval table — every WRITE/PUBLISH-shaped action a mission task
 * dispatches already files a real `IntegrationActionRequest` through the
 * existing `*-tools.ts` ACTION-kind executors (Phase 6-9's own "propose,
 * never execute" convention — see `delegation.ts`). This module only adds
 * the provenance link (mirroring Phase 9's `sourceCrawlIssueId`) and the
 * best-effort callback `approvals/index.ts` fires when that request is
 * finally decided, so the originating `MissionTask` leaves
 * `WAITING_APPROVAL` without the loop having to poll.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordMissionEvent } from './events.js';

const log = createLogger('missions.approvals-bridge');

/** Called right after a propose-only tool call returns its created request
 *  row (`delegation.ts`) — a plain UPDATE rather than threading a mission id
 *  through every existing tool's `execute()`, so no already-audited
 *  WordPress/TikTok tool code needs to change for Phase 10. */
export async function linkMissionTaskApproval(
  input: { organizationId: string; missionTaskId: string; actionRequestId: string },
  db: Db = prisma,
): Promise<void> {
  try {
    await db.integrationActionRequest.updateMany({
      where: { id: input.actionRequestId, organizationId: input.organizationId },
      data: { sourceMissionTaskId: input.missionTaskId },
    });
    await recordMissionEvent(
      {
        missionId: (await db.missionTask.findUnique({ where: { id: input.missionTaskId } }))?.missionId ?? '',
        organizationId: input.organizationId,
        type: 'APPROVAL_REQUESTED',
        metadata: { missionTaskId: input.missionTaskId, actionRequestId: input.actionRequestId },
      },
      db,
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to link mission approval');
  }
}

/**
 * Best-effort — called from `approvals/index.ts::decideActionRequest` after
 * EXECUTED / FAILED, and from `cancelActionRequest`/expiry paths for
 * REJECTED/CANCELLED/EXPIRED (Phase 10 wiring; never masks the real
 * approval-decision result if this callback itself fails).
 */
export async function onMissionActionDecided(
  input: {
    organizationId: string;
    missionTaskId: string;
    outcome: 'EXECUTED' | 'FAILED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
    result?: unknown;
    error?: string | null;
  },
  db: Db = prisma,
): Promise<void> {
  try {
    const task = await db.missionTask.findFirst({
      where: { id: input.missionTaskId, organizationId: input.organizationId },
    });
    if (!task || task.status !== 'WAITING_APPROVAL') return;

    const status =
      input.outcome === 'EXECUTED'
        ? 'SUCCEEDED'
        : input.outcome === 'FAILED'
          ? 'FAILED'
          : 'CANCELLED'; // REJECTED / CANCELLED / EXPIRED all end the task without retry

    await db.missionTask.update({
      where: { id: task.id },
      data: {
        status,
        finishedAt: new Date(),
        actualResult: (input.result ?? { outcome: input.outcome, error: input.error ?? null }) as never,
      },
    });
    await recordMissionEvent(
      {
        missionId: task.missionId,
        organizationId: input.organizationId,
        type:
          input.outcome === 'EXECUTED'
            ? 'APPROVAL_GRANTED'
            : input.outcome === 'REJECTED'
              ? 'APPROVAL_REJECTED'
              : 'TASK_FAILED',
        metadata: { missionTaskId: task.id, outcome: input.outcome },
      },
      db,
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), missionTaskId: input.missionTaskId },
      'failed to resolve mission task after approval decision',
    );
  }
}

/**
 * Pending approvals filed by this mission's own tasks (§26) — reads the
 * SAME `IntegrationActionRequest` rows the generic `/app/integrations/
 * approvals` page already lists, filtered to this mission. No separate
 * approvals table or view exists for missions (the brief's own "reuse
 * existing approval architecture" instruction).
 */
export async function listMissionApprovals(
  organizationId: string,
  missionId: string,
  db: Db = prisma,
) {
  const taskIds = (await db.missionTask.findMany({ where: { missionId, organizationId }, select: { id: true } })).map(
    (t: { id: string }) => t.id,
  );
  if (taskIds.length === 0) return [];
  return db.integrationActionRequest.findMany({
    where: { organizationId, sourceMissionTaskId: { in: taskIds } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
