/**
 * Growth Mission lifecycle: create / read / update / activate / pause /
 * resume / cancel (Phase 10, §4/§48-51). Every mutation re-checks the
 * caller's `mission.manage` permission via the real membership row — not
 * just the session's claimed role — mirroring `automation/rules.ts`'s
 * owner-authorization pattern, since the mission LOOP (no HTTP session)
 * calls these same functions and must derive authorization the same way an
 * interactive Server Action would.
 */
import {
  type Db,
  type MembershipStatus,
  type Prisma,
  type Role,
  prisma,
} from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { createNotification } from '../notifications/index.js';
import { authorize } from '../rbac/authorize.js';
import { detectPlatformOverlap } from './conflict.js';
import { recordMissionEvent } from './events.js';
import { generateMissionPlan, type PlannerModel } from './planner.js';
import type { EmbeddingCapableModel } from '../knowledge/embeddings.js';
import {
  CreateMissionInputSchema,
  MissionApprovalPolicySchema,
  MissionBudgetSchema,
  MissionLimitsSchema,
  type MissionAutonomyLevelKey,
} from './schemas.js';

export interface OwnerAuthz {
  role: Role;
  membershipStatus: MembershipStatus;
}

export async function resolveMissionOwnerAuthz(
  ownerId: string,
  organizationId: string,
  db: Db = prisma,
): Promise<OwnerAuthz | null> {
  const m = await db.membership.findUnique({
    where: { userId_organizationId: { userId: ownerId, organizationId } },
    select: { role: true, status: true },
  });
  if (!m) return null;
  return { role: m.role, membershipStatus: m.status };
}

export async function assertMissionOwnerMay(
  ownerId: string,
  organizationId: string,
  db: Db = prisma,
): Promise<void> {
  const authz = await resolveMissionOwnerAuthz(ownerId, organizationId, db);
  if (!authz) throw AppError.forbidden('You are no longer a member of this organization.');
  authorize({ userId: ownerId, role: authz.role, membershipStatus: authz.membershipStatus }, 'mission.manage');
}

export interface CreateMissionServiceInput {
  organizationId: string;
  userId: string;
  input: unknown;
}

export async function createMission(input: CreateMissionServiceInput, db: Db = prisma) {
  await assertMissionOwnerMay(input.userId, input.organizationId, db);
  const parsed = CreateMissionInputSchema.parse(input.input);

  const limits = MissionLimitsSchema.parse(parsed.limits ?? {});
  const budget = parsed.budget ? MissionBudgetSchema.parse(parsed.budget) : null;
  const approvalPolicy = MissionApprovalPolicySchema.parse({});

  const mission = await db.growthMission.create({
    data: {
      organizationId: input.organizationId,
      createdById: input.userId,
      name: parsed.name,
      description: parsed.description ?? parsed.objective,
      objective: parsed.objective,
      status: 'DRAFT',
      autonomyLevel: parsed.autonomyLevel,
      targetDate: parsed.targetDate,
      allowedPlatforms: parsed.platforms,
      allowedActions: [],
      successMetrics: parsed.successMetrics,
      budget: budget as unknown as Prisma.InputJsonValue,
      constraints: (parsed.constraints ?? null) as unknown as Prisma.InputJsonValue,
      limits: limits,
      approvalPolicy: approvalPolicy,
    },
  });

  await recordMissionEvent(
    { missionId: mission.id, organizationId: input.organizationId, type: 'MISSION_CREATED' },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'mission.created',
      targetType: 'growth_mission',
      targetId: mission.id,
      metadata: { name: mission.name, autonomyLevel: mission.autonomyLevel },
    },
    db,
  );
  return mission;
}

export async function getMission(organizationId: string, missionId: string, db: Db = prisma) {
  const mission = await db.growthMission.findFirst({ where: { id: missionId, organizationId } });
  if (!mission) throw AppError.notFound('Mission');
  return mission;
}

export async function listMissions(
  organizationId: string,
  opts: { status?: string[] } = {},
  db: Db = prisma,
) {
  return db.growthMission.findMany({
    where: { organizationId, ...(opts.status ? { status: { in: opts.status as never } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

/** Everything the mission detail page needs (§24) in one composed read —
 *  no new query pattern, just the existing per-concern read functions. */
export async function getMissionDetail(organizationId: string, missionId: string, db: Db = prisma) {
  const mission = await getMission(organizationId, missionId, db);
  const [milestones, tasks] = await Promise.all([
    db.missionMilestone.findMany({ where: { organizationId, missionId }, orderBy: { order: 'asc' } }),
    db.missionTask.findMany({ where: { organizationId, missionId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { mission, milestones, tasks };
}

/** Runs the planner and moves the mission from DRAFT/BLOCKED into
 *  AWAITING_APPROVAL — the plan is generated but nothing executes yet
 *  (§7/§48: the user must explicitly activate). */
export async function planMission(
  input: {
    organizationId: string;
    userId: string;
    missionId: string;
    /** Phase 11: optional model/embedding deps so the plan is knowledge
     * -aware and can refine its narrative — omitted, planning stays fully
     * deterministic exactly as it did before this phase. */
    model?: PlannerModel;
    embeddingModel?: EmbeddingCapableModel;
  },
  db: Db = prisma,
) {
  await assertMissionOwnerMay(input.userId, input.organizationId, db);
  const mission = await getMission(input.organizationId, input.missionId, db);
  if (mission.status !== 'DRAFT' && mission.status !== 'AWAITING_APPROVAL') {
    throw AppError.conflict(`A mission that is ${mission.status.toLowerCase()} cannot be (re)planned.`);
  }
  await db.growthMission.update({ where: { id: mission.id }, data: { status: 'PLANNING' } });

  const plan = await generateMissionPlan(
    {
      organizationId: input.organizationId,
      mission,
      model: input.model,
      embeddingModel: input.embeddingModel,
    },
    db,
  );

  await db.growthMission.update({
    where: { id: mission.id },
    data: {
      status: 'AWAITING_APPROVAL',
      currentStrategy: plan.strategy,
      taskCount: plan.taskCount,
    },
  });
  await recordMissionEvent(
    {
      missionId: mission.id,
      organizationId: input.organizationId,
      type: 'PLAN_GENERATED',
      metadata: { milestoneCount: plan.milestoneCount, taskCount: plan.taskCount, grounded: plan.strategy.grounded },
    },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'mission.planned',
      targetType: 'growth_mission',
      targetId: mission.id,
      metadata: { milestoneCount: plan.milestoneCount, taskCount: plan.taskCount },
    },
    db,
  );
  return getMission(input.organizationId, input.missionId, db);
}

/** The explicit human activation gate (§48). Only a mission the user has
 *  reviewed (AWAITING_APPROVAL) can become ACTIVE. */
export async function activateMission(
  input: { organizationId: string; userId: string; missionId: string },
  db: Db = prisma,
) {
  await assertMissionOwnerMay(input.userId, input.organizationId, db);
  const mission = await getMission(input.organizationId, input.missionId, db);
  if (mission.status !== 'AWAITING_APPROVAL') {
    throw AppError.conflict('A mission must have a reviewed plan before it can be activated.');
  }
  const now = new Date();
  await db.growthMission.update({
    where: { id: mission.id },
    data: { status: 'ACTIVE', activatedAt: now, nextLoopAt: now, loopFailureCount: 0 },
  });
  await recordMissionEvent(
    { missionId: mission.id, organizationId: input.organizationId, type: 'MISSION_ACTIVATED' },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'mission.activated',
      targetType: 'growth_mission',
      targetId: mission.id,
    },
    db,
  );
  await createNotification(
    {
      organizationId: input.organizationId,
      userId: input.userId,
      kind: 'mission.activated',
      level: 'INFO',
      title: `Mission activated: ${mission.name}`,
      body: `"${mission.name}" is now active and will begin working toward its goal.`,
      linkPath: `/app/missions/${mission.id}`,
      dedupeKey: `mission:${mission.id}:activated`,
      sourceType: 'growth_mission',
      sourceId: mission.id,
    },
    db,
  );

  // §35: flag, never silently resolve, an overlap with another active
  // mission's platforms — activation itself is never blocked by this.
  const conflicts = await detectPlatformOverlap(
    input.organizationId,
    { id: mission.id, allowedPlatforms: mission.allowedPlatforms },
    db,
  );
  if (conflicts.length > 0) {
    await recordMissionEvent(
      {
        missionId: mission.id,
        organizationId: input.organizationId,
        type: 'CONFLICT_DETECTED',
        metadata: { conflicts },
      },
      db,
    );
    await createNotification(
      {
        organizationId: input.organizationId,
        userId: input.userId,
        kind: 'mission.conflict_detected',
        level: 'WARNING',
        title: `"${mission.name}" overlaps with another active mission`,
        body: `This mission shares a platform with: ${conflicts.map((c) => `"${c.otherMissionName}" (${c.overlappingPlatforms.join(', ')})`).join('; ')}. Human decision required — review both missions' boundaries.`,
        linkPath: `/app/missions/${mission.id}`,
        dedupeKey: `mission:${mission.id}:conflict:${conflicts.map((c) => c.otherMissionId).sort().join(',')}`,
        sourceType: 'growth_mission',
        sourceId: mission.id,
      },
      db,
    );
  }

  return getMission(input.organizationId, input.missionId, db);
}

export async function pauseMission(
  input: { organizationId: string; userId: string; missionId: string },
  db: Db = prisma,
) {
  await assertMissionOwnerMay(input.userId, input.organizationId, db);
  const res = await db.growthMission.updateMany({
    where: { id: input.missionId, organizationId: input.organizationId, status: 'ACTIVE' },
    data: { status: 'PAUSED', pausedAt: new Date(), nextLoopAt: null },
  });
  if (res.count === 0) throw AppError.conflict('Only an active mission can be paused.');
  await recordMissionEvent(
    { missionId: input.missionId, organizationId: input.organizationId, type: 'MISSION_PAUSED' },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'mission.paused',
      targetType: 'growth_mission',
      targetId: input.missionId,
    },
    db,
  );
  return getMission(input.organizationId, input.missionId, db);
}

export async function resumeMission(
  input: { organizationId: string; userId: string; missionId: string },
  db: Db = prisma,
) {
  await assertMissionOwnerMay(input.userId, input.organizationId, db);
  const res = await db.growthMission.updateMany({
    where: { id: input.missionId, organizationId: input.organizationId, status: 'PAUSED' },
    data: { status: 'ACTIVE', pausedAt: null, nextLoopAt: new Date(), loopFailureCount: 0 },
  });
  if (res.count === 0) throw AppError.conflict('Only a paused mission can be resumed.');
  await recordMissionEvent(
    { missionId: input.missionId, organizationId: input.organizationId, type: 'MISSION_RESUMED' },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'mission.resumed',
      targetType: 'growth_mission',
      targetId: input.missionId,
    },
    db,
  );
  return getMission(input.organizationId, input.missionId, db);
}

/** Cancellation stops future work but preserves every row — never a delete
 *  (§50: "Do not delete mission history"). */
export async function cancelMission(
  input: { organizationId: string; userId: string; missionId: string },
  db: Db = prisma,
) {
  await assertMissionOwnerMay(input.userId, input.organizationId, db);
  const res = await db.growthMission.updateMany({
    where: {
      id: input.missionId,
      organizationId: input.organizationId,
      status: { in: ['DRAFT', 'PLANNING', 'AWAITING_APPROVAL', 'ACTIVE', 'PAUSED', 'BLOCKED'] },
    },
    data: { status: 'CANCELLED', cancelledAt: new Date(), nextLoopAt: null },
  });
  if (res.count === 0) throw AppError.conflict('This mission cannot be cancelled from its current state.');
  await recordMissionEvent(
    { missionId: input.missionId, organizationId: input.organizationId, type: 'MISSION_CANCELLED' },
    db,
  );
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'mission.cancelled',
      targetType: 'growth_mission',
      targetId: input.missionId,
    },
    db,
  );
  return getMission(input.organizationId, input.missionId, db);
}

export type { MissionAutonomyLevelKey };
