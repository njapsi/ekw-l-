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
import { listToolMetadata } from '../agent/tool-registry.js';
import { assertMissionOwnerMay, resolveMissionOwnerAuthz } from './crud.js';
import { isResourceLocked } from './concurrency.js';
import { delegateMissionTask } from './delegation.js';
import { linkMissionTaskApproval } from './approvals-bridge.js';
import { recordMissionEvent } from './events.js';
import { recordMissionLearning } from './learning.js';
import { allSuccessMetricsMet } from './metrics.js';
import { evaluateMissionPolicy } from './policy.js';
import { missionsHalted } from './killswitch.js';
import { MissionLimitsSchema, type MissionPlatformKey, type MissionSuccessMetricDef } from './schemas.js';
import { computeReadiness, isGraphComplete, type TaskGraphNode } from './task-graph.js';
import { evaluateStopConditions } from './stop-conditions.js';

const log = createLogger('missions.loop');

/** Part 19: `maxPublishPerWeek`/`maxContentGenerationsPerWeek` classify a
 *  task by its dispatched tool's Tool Registry category — `ACTION` tools are
 *  the ones that touch (propose a change to) an external system, `GENERATION`
 *  tools are the ones that produce new draft content — rather than a second,
 *  parallel tool-name list to keep in sync. */
function classifyMissionToolNames(): { publishTools: Set<string>; generationTools: Set<string> } {
  const meta = listToolMetadata();
  return {
    publishTools: new Set(meta.filter((m) => m.category === 'ACTION').map((m) => m.name)),
    generationTools: new Set(meta.filter((m) => m.category === 'GENERATION').map((m) => m.name)),
  };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Count this mission's own approved-and-executed publish/generation calls
 *  in the trailing 7 days, straight from `MissionTask` — no separate
 *  counter to keep in sync, and no fabricated number when there's simply
 *  been no activity yet. */
async function weeklyActionCounts(
  missionId: string,
  toolNames: Set<string>,
  db: Db,
): Promise<number> {
  if (toolNames.size === 0) return 0;
  return db.missionTask.count({
    where: {
      missionId,
      status: 'SUCCEEDED',
      finishedAt: { gte: new Date(Date.now() - SEVEN_DAYS_MS) },
      toolName: { in: [...toolNames] },
    },
  });
}

export interface MissionTickResult {
  missionId: string;
  outcome:
    | 'ran_task'
    | 'no_ready_task'
    | 'completed'
    | 'blocked'
    | 'failed'
    | 'skipped_not_active'
    | 'skipped_owner_lost'
    | 'skipped_halted';
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
  if (missionsHalted(mission.organizationId)) {
    return { missionId, outcome: 'skipped_halted', detail: 'MISSIONS_HALT is set for this org or globally' };
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
  const { publishTools, generationTools } = classifyMissionToolNames();
  const [publishesInLast7Days, contentGenerationsInLast7Days] = await Promise.all([
    weeklyActionCounts(mission.id, publishTools, db),
    weeklyActionCounts(mission.id, generationTools, db),
  ]);

  const stop = evaluateStopConditions({
    status: mission.status,
    targetDate: mission.targetDate,
    activatedAt: mission.activatedAt,
    now: new Date(),
    limits,
    toolCallCount: mission.toolCallCount,
    taskCount: mission.taskCount,
    budgetMaxUsd: budget?.maxUsd ?? null,
    budgetSpentUsd: budget?.spentUsd ?? 0,
    loopFailureCount: mission.loopFailureCount,
    allSuccessMetricsMet: metGoal,
    requiredIntegrationDisconnected: disconnected,
    publishesInLast7Days,
    contentGenerationsInLast7Days,
  });
  // WEEKLY_LIMIT_REACHED is deliberately NOT a hard stop here (unlike every
  // other reason): it is self-resetting within days, and hitting it means
  // only "this ONE category of action is throttled this week", not that the
  // whole mission is unsafe to continue — a mission with, say, its publish
  // quota used up should still keep doing read/analysis work. The throttle
  // itself is enforced below, in task selection.
  if (stop && stop !== 'USER_PAUSED' && stop !== 'WEEKLY_LIMIT_REACHED') {
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

  const publishThrottled = publishesInLast7Days >= limits.maxPublishPerWeek;
  const generationThrottled = contentGenerationsInLast7Days >= limits.maxContentGenerationsPerWeek;
  const ready = freshTasks
    .filter((t) => t.status === 'READY')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const nextTask = ready.find((t) => {
    if (t.toolName && publishThrottled && publishTools.has(t.toolName)) return false;
    if (t.toolName && generationThrottled && generationTools.has(t.toolName)) return false;
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

  const claimed = await executeTaskAndRecord(mission, nextTask, db);
  if (!claimed) return { missionId, outcome: 'no_ready_task', detail: 'resource claimed by a concurrent tick' };
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
 *
 * Phase 12 hardening: claims the task with a conditional `updateMany`
 * (`READY` → `RUNNING`) instead of an unconditional `update`, and returns
 * `false` without dispatching anything if the claim fails. Without this, two
 * overlapping calls for the same mission — plausible since `mission-sweep`
 * has no per-mission lock and the worker runs with `concurrency: 4` — could
 * both read the same `READY` task and both dispatch it, double-publishing or
 * double-charging an external action.
 */
async function executeTaskAndRecord(
  mission: { id: string; organizationId: string; createdById: string },
  task: MissionTaskRow,
  db: Db,
): Promise<boolean> {
  const claim = await db.missionTask.updateMany({
    where: { id: task.id, status: 'READY' },
    data: { status: 'RUNNING', startedAt: new Date(), attempt: { increment: 1 } },
  });
  if (claim.count === 0) {
    log.info({ missionId: mission.id, taskId: task.id }, 'task claim lost to a concurrent tick — skipping');
    return false;
  }
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

  // Phase 12: `executeAgentTool` meters the org's real `TOOL_CALLS` usage
  // meter on any dispatch (success, pending-approval, or failed — see
  // `agent/tool-executor.ts::meterCall`), but this mission's own
  // `toolCallCount` — the number `ACTION_LIMIT_REACHED` checks — was
  // previously only ever incremented on success, so a mission that kept
  // dispatching real tool calls that failed or sat in `requires_approval`
  // never tripped its own action-limit stop condition. A task with no
  // `toolName` (a pure human-decision point) never called a tool at all, so
  // it must not count.
  const wasRealToolCall = task.toolName !== null;

  if (result.outcome === 'ok') {
    await db.missionTask.update({
      where: { id: task.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date(), actualResult: (result.detail ?? { summary: result.summary }) as never },
    });
    await db.growthMission.update({
      where: { id: mission.id },
      data: {
        ...(wasRealToolCall ? { toolCallCount: { increment: 1 } } : {}),
        lastLoopAt: new Date(),
        nextLoopAt: new Date(),
        loopFailureCount: 0,
      },
    });
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
    await db.growthMission.update({
      where: { id: mission.id },
      data: {
        ...(wasRealToolCall ? { toolCallCount: { increment: 1 } } : {}),
        lastLoopAt: new Date(),
        nextLoopAt: new Date(Date.now() + 60_000),
      },
    });
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
      data: {
        ...(wasRealToolCall ? { toolCallCount: { increment: 1 } } : {}),
        lastLoopAt: new Date(),
        nextLoopAt: new Date(Date.now() + 60_000),
        loopFailureCount: { increment: 1 },
      },
    });
    await recordMissionEvent(
      { missionId: mission.id, organizationId: mission.organizationId, type: 'TASK_FAILED', metadata: { taskId: task.id, error: result.summary, willRetry: !permanentlyFailed } },
      db,
    );
  }
  return true;
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
  if (missionsHalted(mission.organizationId)) {
    return { missionId: input.missionId, outcome: 'skipped_halted', detail: 'MISSIONS_HALT is set for this org or globally' };
  }

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
  // Part 19's weekly caps are a safety limit, not merely an autonomy gate —
  // a human explicitly clicking "run now" must not be able to bypass them,
  // even though this manual path otherwise ignores `autoExecutable`.
  if (task.toolName) {
    const limits = MissionLimitsSchema.parse(mission.limits ?? {});
    const { publishTools, generationTools } = classifyMissionToolNames();
    if (publishTools.has(task.toolName)) {
      const count = await weeklyActionCounts(mission.id, publishTools, db);
      if (count >= limits.maxPublishPerWeek) {
        return { missionId: input.missionId, outcome: 'blocked', detail: 'weekly publish limit reached' };
      }
    }
    if (generationTools.has(task.toolName)) {
      const count = await weeklyActionCounts(mission.id, generationTools, db);
      if (count >= limits.maxContentGenerationsPerWeek) {
        return { missionId: input.missionId, outcome: 'blocked', detail: 'weekly content-generation limit reached' };
      }
    }
  }
  if (task.resourceKey && (await isResourceLocked(mission.organizationId, task.resourceKey, task.id, db))) {
    return { missionId: input.missionId, outcome: 'no_ready_task', detail: 'resource locked by another task' };
  }

  const claimed = await executeTaskAndRecord(mission, task, db);
  if (!claimed) {
    return { missionId: input.missionId, outcome: 'no_ready_task', detail: 'resource claimed by a concurrent tick' };
  }
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
