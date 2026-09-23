/**
 * Part 51-52: scheduled knowledge maintenance, dispatched from the
 * **existing** worker/BullMQ infrastructure (no new job system — see
 * `apps/worker/src/processors/agent.ts`'s `knowledge.*` job cases and
 * `apps/worker/src/main.ts`'s repeatable-job registration).
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { markStaleKnowledge } from './freshness.js';
import { detectConflictsForItem } from './conflicts.js';

const log = createLogger('knowledge.jobs');

/** `knowledge.freshness.check` — demotes every org's expired items to STALE. */
export async function runKnowledgeFreshnessSweepJob(db: Db = prisma): Promise<{ staled: number }> {
  const staled = await markStaleKnowledge(undefined, db);
  return { staled };
}

/**
 * `knowledge.conflict.detect` — a full sweep, on top of the inline check
 * already run at creation time (`items.ts::createKnowledgeItem`), for items
 * created before this phase's conflict detection existed or via a bulk path
 * that skipped it (`skipConflictCheck`). Bounded to recently-updated items
 * per org so this stays cheap on a large knowledge base.
 */
export async function runKnowledgeConflictSweepJob(db: Db = prisma): Promise<{ checked: number; found: number }> {
  const orgs = await db.organization.findMany({
    where: { deletedAt: null, knowledgeItems: { some: {} } },
    select: { id: true },
  });
  let checked = 0;
  let found = 0;
  for (const org of orgs) {
    const recent = await db.knowledgeItem.findMany({
      where: {
        organizationId: org.id,
        status: { notIn: ['ARCHIVED', 'REJECTED', 'EXPIRED', 'CONFLICTED'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: { id: true },
    });
    for (const item of recent) {
      checked++;
      try {
        found += await detectConflictsForItem(org.id, item.id, db);
      } catch (e) {
        log.warn({ organizationId: org.id, knowledgeId: item.id, err: String(e) }, 'conflict sweep failed for item');
      }
    }
  }
  return { checked, found };
}

/** `memory.expire` — a review candidate nobody acted on in 30 days is
 * superseded rather than sitting in the queue forever; the underlying
 * conversation that produced it is long gone from the user's short-term
 * context by then. Never silently converts to accepted. */
export async function runMemoryCandidateExpirySweepJob(
  db: Db = prisma,
  olderThanDays = 30,
): Promise<{ expired: number }> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await db.memoryCandidate.updateMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    data: { status: 'SUPERSEDED', resolvedAt: new Date() },
  });
  return { expired: result.count };
}
