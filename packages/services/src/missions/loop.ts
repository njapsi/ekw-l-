/**
 * The Growth Mission execution loop (Phase 10, §20/§53) — one bounded tick
 * per call: OBSERVE (readiness + stop conditions) → PLAN (pick the next
 * task) → ACT (delegate it) → VERIFY/MEASURE (record the result) → LEARN
 * (a lightweight observation) → REPLAN (readiness recompute). A tick never
 * runs more than one task, mirroring `automation/runner.ts::
 * executeAutomationRun`'s own "bounded, inline, one unit of work" design —
 * the worker sweep calls this repeatedly rather than looping internally, so
 * no single call can run unbounded.
 *
 * Every safety property lives in code this module calls, never here:
 * `assertMissionOwnerMay` (RBAC), `evaluateMissionPolicy` (mission
 * boundaries), `executeAgentTool`/`requestIntegrationAction` (governance +
 * approval floor). This module's only independent responsibility is
 * sequencing and bookkeeping.
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { loadOrgContext } from '../agent/context.js';
import { assertMissionOwnerMay, resolveMissionOwnerAuthz } from './crud.js';
import { isResourceLocked } from './concurrency.js';
import { delegateMissionTask } from './delegation.js';
import { linkMissionTaskApproval } from './approvals-bridge.js';
import { recordMissionEvent } from './events.js';
import { recordMissionLearning } from './learning.js';
import { allSuccessMetricsMet } from './metrics.js';
import { evaluateMissionPolicy } from './policy.js';
import { MissionLimitsSchema, type MissionPlatformKey, type MissionSuccessMetricDef } from './schemas.js';
import { computeReadiness, isGraphComplete, type TaskGraphNode } from './task-graph.js';
import { evaluateStopConditions } from './stop-conditions.js';

const log = createLogger('missions.loop');

export interface MissionTickResult {
  missionId: string;
  outcome:
    | 'ran_task'
    | 'no_ready_task'
    | 'completed'
    | 'blocked'
    | 'failed'
    | 'skipped_not_active'
    | 'skipped_owner_lost';
  detail?: string;
}

/** Re-checked disconnection: a platform the mission actually uses (has at
 *  least one non-terminal task on it) that is no longer connected. */
async function requiredIntegrationDisconnected(
  organizationId: string,
  tasks: Array<{ platform: MissionPlatformKey; status: string }>,
  db: Db,
): Promise<boolean> {
  const used = new Set(
    tasks.filter((t) => t.status !== 'CANCELLED' && t.status !== 'SKIPPED').map((t) => t.platform),
  );
  if (used.size === 0) return false;
  const ctx = await loadOrgContext(organizationId, db);
  if (used.has('YOUTUBE') && !ctx.youtube.connected) return true;
  if (used.has('TIKTOK') && !ctx.tiktok.connected) return true;
  if (used.has('WORDPRESS') && !ctx.wordpress.connected) return true;
  if (used.has('SEO') && ctx.seo.websites === 0) return true;
  return false;
}

async function finishMission(
  input: { organizationId: string; missionId: string; status: 'COMPLETED' | 'BLOCKED' | 'FAILED'; reason: string },
  db: Db,
): Promise<void> {
  const now = new Date();
  await db.growthMission.update({
    where: { id: input.missionId },
    data: {
      status: input.status,
      nextLoopAt: null,
      ...(input.status === 'COMPLETED' ? { completedAt: now } : {}),
    },
  });
  await recordMissionEvent(
    {
      missionId: input.missionId,
      organizationId: input.organizationId,
      type:
        input.status === 'COMPLETED'
          ? 'MISSION_COMPLETED'
          : input.status === 'FAILED'
            ? 'MISSION_FAILED'
            : 'MISSION_BLOCKED',
      metadata: { reason: input.reason },
    },
    db,
  );
}

/**
 * Runs exactly one bounded step for one ACTIVE mission. Safe to call
 * repeatedly and concurrently across different missions — never mutates
 * more than one mission's own rows, and every write inside is scoped to
 * `input.missionId`'s own `organizationId`.
 */
export async function runMissionTick(missionId: string, db: Db = prisma): Promise<MissionTickResult> {
  const mission = await db.growthMission.findUnique({ where: { id: missionId } });
  if (!mission) return { missionId, outcome: 'skipped_not_active', detail: 'mission not found' };
  if (mission.status !== 'ACTIVE') {
    return { missionId, outcome: 'skipped_not_active', detail: mission.status };
  }

  // Re-check the creator's current RBAC — mirrors automation's owner
  // recheck exactly: losing the permission blocks the mission rather than
  // silently continuing to act on their behalf.
  const authz = await resolveMissionOwnerAuthz(mission.createdById, mission.organizationId, db);
  try {
    if (!authz) throw new Error('owner left the organization');
    await assertMissionOwnerMay(mission.createdById, mission.organizationId, db);
  } catch {
    await db.growthMission.update({
      where: { id: mission.id },
      data: { status: 'BLOCKED', nextLoopAt: null },
    });
    await recordMissionEvent(
      {
        missionId: mission.id,
        organizationId: mission.organizationId,
        type: 'MISSION_BLOCKED',
        metadata: { reason: 'owner lost mission.manage permission' },
      },
      db,
    );
    return { missionId, outcome: 'skipped_owner_lost' };
  }

  const tasks = await db.missionTask.findMany({ where: { missionId: mission.id } });
  const graphNodes: TaskGraphNode[] = tasks.map((t) => ({
    id: t.id,
    status: t.status,
    dependsOnTaskIds: t.dependsOnTaskIds,
  }));
  const readiness = computeReadiness(graphNodes);
  for (const id of readiness.newlyReady) {
    await db.missionTask.update({ where: { id }, data: { status: 'READY' } });
    await recordMissionEvent({ missionId: mission.id, organizationId: mission.organizationId, type: 'TASK_READY', metadata: { taskId: id } }, db);
  }
  for (const id of readiness.newlyBlocked) {
    await db.missionTask.update({ where: { id }, data: { status: 'BLOCKED' } });
    await recordMissionEvent({ missionId: mission.id, organizationId: mission.organizationId, type: 'TASK_BLOCKED', metadata: { taskId: id } }, db);
  }

  const limits = MissionLimitsSchema.parse(mission.limits ?? {});
  const budget = mission.budget as { maxUsd: number | null; spentUsd: number } | null;
  const successMetrics = (mission.successMetrics ?? []) as MissionSuccessMetricDef[];
  const metGoal = await allSuccessMetricsMet(mission.organizationId, mission.id, successMetrics, db);
  const disconnected = await requiredIntegrationDisconnected(mission.organizationId, tasks, db);

  const stop = evaluateStopConditions({
    status: mission.status,
    targetDate: mission.targetDate,
    now: new Date(),
    limits,
    toolCallCount: mission.toolCallCount,
    taskCount: mission.taskCount,
    budgetMaxUsd: budget?.maxUsd ?? null,
    budgetSpentUsd: budget?.spentUsd ?? 0,
    loopFailureCount: mission.loopFailureCount,
    allSuccessMetricsMet: metGoal,
    requiredIntegrationDisconnected: disconnected,
  });
  if (stop && stop !== 'USER_PAUSED') {
    const status = stop === 'GOAL_ACHIEVED' || stop === 'DEADLINE_REACHED' ? 'COMPLETED' : 'BLOCKED';
    await finishMission({ organizationId: mission.organizationId, missionId: mission.id, status, reason: stop }, db);
    return { missionId, outcome: status === 'COMPLETED' ? 'completed' : 'blocked', detail: stop };
  }

  const freshTasks = await db.missionTask.findMany({ where: { missionId: mission.id } });
  const graphNodes2 = freshTasks.map((t) => ({ id: t.id, status: t.status, dependsOnTaskIds: t.dependsOnTaskIds }));
  if (isGraphComplete(graphNodes2)) {
    // A graph can terminate two ways: every task succeeded (or was
    // deliberately cancelled/skipped, never a real failure), or at least
    // one task FAILED / was permanently BLOCKED by a failed dependency —
    // that is not a success, and must never be reported as one.
    const anyFailure = freshTasks.some((t) => t.status === 'FAILED' || t.status === 'BLOCKED');
    await finishMission(
      {
        organizationId: mission.organizationId,
        missionId: mission.id,
        status: anyFailure ? 'FAILED' : 'COMPLETED',
        reason: anyFailure ? 'one or more tasks failed or were permanently blocked' : 'every task succeeded',
      },
      db,
    );
    return { missionId, outcome: anyFailure ? 'failed' : 'completed', detail: 'every task reached a terminal state' };
  }

  const ready = freshTasks
    .filter((t) => t.status === 'READY')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const nextTask = ready.find((t) => {
    const decision = evaluateMissionPolicy(
      {
        allowedPlatforms: mission.allowedPlatforms,
        allowedActions: mission.allowedActions,
        autonomyLevel: mission.autonomyLevel,
        alwaysApproveRisks: (mission.approvalPolicy as { alwaysApprove?: string[] } | null)?.alwaysApprove as never[] ?? [],
      },
      { platform: t.platform, toolName: t.toolName },
    );
    return decision.permitted && decision.autoExecutable;
  });

  if (!nextTask) {
    await db.growthMission.update({
      where: { id: mission.id },
      data: { nextLoopAt: new Date(Date.now() + 60_000), lastLoopAt: new Date() },
    });
    return { missionId, outcome: 'no_ready_task' };
  }

  if (nextTask.resourceKey && (await isResourceLocked(mission.organizationId, nextTask.resourceKey, nextTask.id, db))) {
    await db.growthMission.update({
      where: { id: mission.id },
      data: { nextLoopAt: new Date(Date.now() + 60_000), lastLoopAt: new Date() },
    });
    return { missionId, outcome: 'no_ready_task', detail: 'resource locked by another task' };
  }

  await executeTaskAndRecord(mission, nextTask, db);
  return { missionId, outcome: 'ran_task', detail: nextTask.title };
}

interface MissionTaskRow {
  id: string;
  title: string;
  description: string;
  toolName: string | null;
  toolInput: unknown;
  attempt: number;
  maxRetries: number;
}

/**
 * Runs one already-selected task and records the outcome. Shared by the
 * automated sweep (`runMissionTick`, only for `autoExecutable` tasks) and
 * the explicit human "run this task now" trigger (`runMissionTaskManually`,
 * below) — the dispatch/bookkeeping logic is identical either way; what
 * differs is only how the task was chosen and by whom.
 */
async function executeTaskAndRecord(
  mission: { id: string; organizationId: string; createdById: string },
  task: MissionTaskRow,
  db: Db,
): Promise<void> {
  await db.missionTask.update({ where: { id: task.id }, data: { status: 'RUNNING', startedAt: new Date(), attempt: { increment: 1 } } });
  await recordMissionEvent({ missionId: mission.id, organizationId: mission.organizationId, type: 'TASK_STARTED', metadata: { taskId: task.id, title: task.title } }, db);

  let result;
  try {
    result = await delegateMissionTask(
      {
        organizationId: mission.organizationId,
        userId: mission.createdById,
        missionId: mission.id,
        task: { id: task.id, title: task.title, description: task.description, toolName: task.toolName, toolInput: task.toolInput },
      },
      db,
    );
  } catch (err) {
    result = { outcome: 'failed' as const, summary: err instanceof Error ? err.message : 'Task failed unexpectedly.' };
  }

  if (result.outcome === 'ok') {
    await db.missionTask.update({
      where: { id: task.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date(), actualResult: (result.detail ?? { summary: result.summary }) as never },
    });
    await db.growthMission.update({ where: { id: mission.id }, data: { toolCallCount: { increment: 1 }, lastLoopAt: new Date(), nextLoopAt: new Date(), loopFailureCount: 0 } });
    await recordMissionEvent({ missionId: mission.id, organizationId: mission.organizationId, type: 'TASK_SUCCEEDED', metadata: { taskId: task.id, summary: result.summary } }, db);
    await recordMissionLearning(
      {
        organizationId: mission.organizationId,
        missionId: mission.id,
        type: 'OBSERVATION',
        title: task.title,
        detail: result.summary,
        relatedTaskId: task.id,
        confidence: 1,
      },
      db,
    );
  } else if (result.outcome === 'requires_approval') {
    await db.missionTask.update({ where: { id: task.id }, data: { status: 'WAITING_APPROVAL' } });
    if (result.actionRequestId) {
      await linkMissionTaskApproval({ organizationId: mission.organizationId, missionTaskId: task.id, actionRequestId: result.actionRequestId }, db);
    }
    await db.growthMission.update({ where: { id: mission.id }, data: { lastLoopAt: new Date(), nextLoopAt: new Date(Date.now() + 60_000) } });
    await recordMissionEvent({ missionId: mission.id, organizationId: mission.organizationId, type: 'APPROVAL_REQUESTED', metadata: { taskId: task.id } }, db);
  } else {
    const permanentlyFailed = task.attempt + 1 > task.maxRetries;
    await db.missionTask.update({
      where: { id: task.id },
      data: {
        status: permanentlyFailed ? 'FAILED' : 'READY',
        finishedAt: permanentlyFailed ? new Date() : null,
        actualResult: { error: result.summary } as never,
      },
    });
    await db.growthMission.update({
      where: { id: mission.id },
      data: { lastLoopAt: new Date(), nextLoopAt: new Date(Date.now() + 60_000), loopFailureCount: { increment: 1 } },
    });
    await recordMissionEvent(
      { missionId: mission.id, organizationId: mission.organizationId, type: 'TASK_FAILED', metadata: { taskId: task.id, error: result.summary, willRetry: !permanentlyFailed } },
      db,
    );
  }
}

/**
 * The explicit, human-triggered counterpart to the automated sweep (§54:
 * "the user must always be able to see what requires approval / trigger it
 * themselves"). Ignores `autoExecutable` (a human is explicitly asking) but
 * still enforces `permitted` — a mission boundary can never be bypassed by
 * asking a different way — RBAC, and the concurrency guard.
 */
export async function runMissionTaskManually(
  input: { organizationId: string; userId: string; missionId: string; taskId: string },
  db: Db = prisma,
): Promise<MissionTickResult> {
  await assertMissionOwnerMay(input.userId, input.organizationId, db);
  const mission = await db.growthMission.findFirst({ where: { id: input.missionId, organizationId: input.organizationId } });
  if (!mission) return { missionId: input.missionId, outcome: 'skipped_not_active', detail: 'mission not found' };
  if (mission.status !== 'ACTIVE') return { missionId: input.missionId, outcome: 'skipped_not_active', detail: mission.status };

  const task = await db.missionTask.findFirst({ where: { id: input.taskId, missionId: mission.id } });
  if (!task || task.status !== 'READY') {
    return { missionId: input.missionId, outcome: 'no_ready_task', detail: 'this task is not ready to run' };
  }

  const decision = evaluateMissionPolicy(
    {
      allowedPlatforms: mission.allowedPlatforms,
      allowedActions: mission.allowedActions,
      autonomyLevel: mission.autonomyLevel,
      alwaysApproveRisks:
        ((mission.approvalPolicy as { alwaysApprove?: string[] } | null)?.alwaysApprove as never[]) ?? [],
    },
    { platform: task.platform, toolName: task.toolName },
  );
  if (!decision.permitted) {
    return { missionId: input.missionId, outcome: 'blocked', detail: decision.reason };
  }
  if (task.resourceKey && (await isResourceLocked(mission.organizationId, task.resourceKey, task.id, db))) {
    return { missionId: input.missionId, outcome: 'no_ready_task', detail: 'resource locked by another task' };
  }

  await executeTaskAndRecord(mission, task, db);
  return { missionId: input.missionId, outcome: 'ran_task', detail: task.title };
}

/** The platform-wide sweep — mirrors `automation/runner.ts::dueAutomations`
 *  exactly: a scheduler query across every org, each tick then executes
 *  scoped to its own mission's `organizationId`. */
export async function dueMissions(now: Date = new Date(), db: Db = prisma, limit = 200) {
  return db.growthMission.findMany({
    where: {
      status: 'ACTIVE',
      nextLoopAt: { not: null, lte: now },
      organization: { deletedAt: null, deletionScheduledAt: null },
    },
    orderBy: { nextLoopAt: 'asc' },
    take: limit,
    select: { id: true },
  });
}

export async function runMissionSweep(db: Db = prisma): Promise<{ ticked: number }> {
  const due = await dueMissions(new Date(), db);
  for (const m of due) {
    try {
      await runMissionTick(m.id, db);
    } catch (err) {
      log.error({ missionId: m.id, err: err instanceof Error ? err.message : String(err) }, 'mission tick failed');
    }
  }
  return { ticked: due.length };
}
