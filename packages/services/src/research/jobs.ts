/** Worker entry points for the research lifecycle (Part 51, 82-83). Reuses
 * the existing `agent-run` BullMQ queue (Phase 10 already reactivated it for
 * mission jobs) rather than a new queue. */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import type { ResearchModel } from './engine.js';
import { runResearchProject } from './engine.js';

const log = createLogger('research.jobs');

/**
 * `research.dispatch.sweep` — the real "runs asynchronously" mechanism
 * (Part 82: never inline in a web request). This codebase has no web→worker
 * job producer anywhere (`apps/web` doesn't depend on `bullmq` at all); every
 * existing background flow instead has the **worker's own repeatable tick**
 * discover pending work and process it in-process — exactly
 * `missions/loop.ts::runMissionSweep`'s shape. `research.project.create`
 * only ever creates a `REQUESTED` row and returns immediately; this sweep
 * (registered in `apps/worker/src/main.ts`) picks it up within its next
 * interval and calls `runResearchProject` directly, no second job enqueued.
 */
export async function runResearchDispatchSweepJob(
  deps: { model?: ResearchModel } = {},
  db: Db = prisma,
  limit = 5,
): Promise<{ dispatched: number }> {
  const due = await db.researchProject.findMany({
    where: { status: 'REQUESTED' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, organizationId: true },
  });
  for (const project of due) {
    try {
      await runResearchProject(project.organizationId, project.id, { model: deps.model, db });
    } catch (e) {
      log.error({ researchProjectId: project.id, err: String(e) }, 'research dispatch sweep: project failed');
    }
  }
  return { dispatched: due.length };
}

export async function runResearchProjectJob(
  input: { organizationId: string; researchProjectId: string },
  deps: { model?: ResearchModel } = {},
  db: Db = prisma,
): Promise<void> {
  try {
    await runResearchProject(input.organizationId, input.researchProjectId, { model: deps.model, db });
  } catch (e) {
    log.error({ ...input, err: String(e) }, 'research project job failed');
    await db.researchProject
      .updateMany({
        where: { id: input.researchProjectId, organizationId: input.organizationId, status: { not: 'CANCELLED' } },
        data: { status: 'FAILED', failureReason: 'An internal error interrupted this research run.', completedAt: new Date() },
      })
      .catch(() => undefined);
  }
}

/** `research.cleanup` — a research run that never reached a terminal state
 * (a worker crash mid-run) is recovered rather than left stuck forever,
 * mirroring `IntegrationSyncRun`'s existing stale-run recovery. */
export async function runResearchCleanupSweepJob(db: Db = prisma, staleAfterMinutes = 30): Promise<{ recovered: number }> {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000);
  const result = await db.researchProject.updateMany({
    where: {
      status: { in: ['PLANNING', 'SEARCHING', 'COLLECTING', 'ANALYZING', 'VERIFYING'] },
      updatedAt: { lt: cutoff },
    },
    data: { status: 'FAILED', failureReason: 'This research run stalled and was recovered by a cleanup sweep.', completedAt: new Date() },
  });
  return { recovered: result.count };
}
