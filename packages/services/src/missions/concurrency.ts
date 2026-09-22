/**
 * Resource-key concurrency guard (Phase 10, §37/§38) — prevents two
 * `MissionTask`s, even across different missions, from both being RUNNING
 * or WAITING_APPROVAL against the same real-world resource (e.g.
 * `wordpress_post:123`) at once. A task with no `resourceKey` (most
 * read/analyze tasks) is never gated — the guard only matters for the
 * handful of write-shaped tasks that target one identifiable resource.
 *
 * This is deliberately a plain row check, not a distributed lock: the loop
 * processes one mission tick at a time (see `loop.ts`), so a simple
 * "is anything else already active on this key" query is sufficient and
 * avoids a new lock table/Redis dependency for Phase 10.
 */
import { type Db, prisma } from '@growth-agent/db';

const ACTIVE_STATUSES = ['RUNNING', 'WAITING_APPROVAL'] as const;

/** True when another task already holds this resource key. `excludeTaskId`
 *  lets a task check against every *other* task without matching itself. */
export async function isResourceLocked(
  organizationId: string,
  resourceKey: string,
  excludeTaskId: string,
  db: Db = prisma,
): Promise<boolean> {
  const holder = await db.missionTask.findFirst({
    where: {
      organizationId,
      resourceKey,
      status: { in: [...ACTIVE_STATUSES] as never },
      id: { not: excludeTaskId },
    },
    select: { id: true },
  });
  return Boolean(holder);
}
