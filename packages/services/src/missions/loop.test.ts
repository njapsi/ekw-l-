import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { runMissionTick } from './loop.js';

let db: MemoryDb;
let asDb: Db;

async function seedActiveMission(overrides: Record<string, unknown> = {}) {
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.user.create({ data: { id: 'user_1', email: 'u@example.com' } });
  await db.membership.create({ data: { userId: 'user_1', organizationId: 'org_1', role: 'MEMBER', status: 'ACTIVE' } });
  return db.growthMission.create({
    data: {
      id: 'mission_1',
      organizationId: 'org_1',
      createdById: 'user_1',
      name: 'Grow',
      description: 'Grow',
      objective: 'Grow',
      status: 'ACTIVE',
      autonomyLevel: 'ASSISTED',
      allowedPlatforms: ['CROSS_PLATFORM'],
      allowedActions: [],
      successMetrics: [],
      limits: { maxToolCalls: 500, maxTasks: 100, maxDurationDays: 180, maxRetries: 2, maxPublishPerWeek: 3, maxContentGenerationsPerWeek: 10 },
      taskCount: 1,
      ...overrides,
    },
  });
}

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

describe('runMissionTick', () => {
  it('is a no-op for a mission that is not ACTIVE', async () => {
    await seedActiveMission({ status: 'PAUSED' });
    const result = await runMissionTick('mission_1', asDb);
    expect(result.outcome).toBe('skipped_not_active');
  });

  it('is a no-op for a mission id that does not exist', async () => {
    const result = await runMissionTick('missing', asDb);
    expect(result.outcome).toBe('skipped_not_active');
  });

  it('MISSIONS_HALT stops a tick globally without touching mission status (Phase 12 kill switch)', async () => {
    await seedActiveMission();
    process.env.MISSIONS_HALT = '1';
    try {
      const result = await runMissionTick('mission_1', asDb);
      expect(result.outcome).toBe('skipped_halted');
      const mission = await db.growthMission.findUnique({ where: { id: 'mission_1' } });
      expect(mission?.status).toBe('ACTIVE');
    } finally {
      delete process.env.MISSIONS_HALT;
    }
  });

  it('MISSIONS_HALT_ORG_IDS stops only the listed organization', async () => {
    await seedActiveMission();
    process.env.MISSIONS_HALT_ORG_IDS = 'org_other,org_1';
    try {
      const result = await runMissionTick('mission_1', asDb);
      expect(result.outcome).toBe('skipped_halted');
    } finally {
      delete process.env.MISSIONS_HALT_ORG_IDS;
    }
  });

  it('blocks the mission when its owner has left the organization', async () => {
    await seedActiveMission();
    await db.membership.deleteMany({ where: { userId: 'user_1', organizationId: 'org_1' } });
    const result = await runMissionTick('mission_1', asDb);
    expect(result.outcome).toBe('skipped_owner_lost');
    const mission = await db.growthMission.findUnique({ where: { id: 'mission_1' } });
    expect(mission?.status).toBe('BLOCKED');
  });

  it('a pure human-decision task (no tool) runs, opens a linked Task, and succeeds', async () => {
    await seedActiveMission();
    await db.missionTask.create({
      data: {
        id: 'task_1',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'Review the plan',
        description: 'A human decision point.',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: [],
        status: 'PENDING',
      },
    });

    const result = await runMissionTick('mission_1', asDb);
    expect(result.outcome).toBe('ran_task');

    const task = await db.missionTask.findUnique({ where: { id: 'task_1' } });
    expect(task?.status).toBe('SUCCEEDED');

    const linkedTasks = await db.task.findMany({ where: { sourceMissionTaskId: 'task_1' } });
    expect(linkedTasks).toHaveLength(1);

    const events = await db.missionEvent.findMany({ where: { missionId: 'mission_1' } });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['TASK_READY', 'TASK_STARTED', 'TASK_SUCCEEDED']),
    );
  });

  it('completes the mission once every task has reached a terminal state', async () => {
    await seedActiveMission();
    await db.missionTask.create({
      data: {
        id: 'task_1',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'Only task',
        description: 'd',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: [],
        status: 'SUCCEEDED',
      },
    });
    const result = await runMissionTick('mission_1', asDb);
    expect(result.outcome).toBe('completed');
    const mission = await db.growthMission.findUnique({ where: { id: 'mission_1' } });
    expect(mission?.status).toBe('COMPLETED');
    expect(mission?.completedAt).toBeTruthy();
  });

  it('does not run a task whose dependency has not succeeded yet', async () => {
    await seedActiveMission();
    await db.missionTask.create({
      data: {
        id: 'task_1',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'First',
        description: 'd',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: [],
        status: 'RUNNING',
      },
    });
    await db.missionTask.create({
      data: {
        id: 'task_2',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'Second',
        description: 'd',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: ['task_1'],
        status: 'PENDING',
      },
    });
    const result = await runMissionTick('mission_1', asDb);
    expect(result.outcome).toBe('no_ready_task');
    const task2 = await db.missionTask.findUnique({ where: { id: 'task_2' } });
    expect(task2?.status).toBe('PENDING');
  });

  it('permanently blocks a task whose dependency failed, without ever running it', async () => {
    await seedActiveMission();
    await db.missionTask.create({
      data: {
        id: 'task_1',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'First',
        description: 'd',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: [],
        status: 'FAILED',
      },
    });
    await db.missionTask.create({
      data: {
        id: 'task_2',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'Second',
        description: 'd',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: ['task_1'],
        status: 'PENDING',
      },
    });
    const result = await runMissionTick('mission_1', asDb);
    // task_1 FAILED, task_2 now BLOCKED — graph is terminal but not a
    // success, so the mission must be reported FAILED, never COMPLETED.
    expect(result.outcome).toBe('failed');
    const task2 = await db.missionTask.findUnique({ where: { id: 'task_2' } });
    expect(task2?.status).toBe('BLOCKED');
    const mission = await db.growthMission.findUnique({ where: { id: 'mission_1' } });
    expect(mission?.status).toBe('FAILED');
  });

  it('two concurrent ticks on the same mission never both run the same task (Phase 12 claim hardening)', async () => {
    await seedActiveMission();
    await db.missionTask.create({
      data: {
        id: 'task_1',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'Only task',
        description: 'A human decision point.',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: [],
        status: 'PENDING',
      },
    });
    // Both calls observe the task as READY before either claims it — this
    // is exactly the race an unclaimed sweep dispatch used to allow.
    const [a, b] = await Promise.all([runMissionTick('mission_1', asDb), runMissionTick('mission_1', asDb)]);
    const outcomes = [a.outcome, b.outcome].sort();
    // Exactly one call actually ran the task; the other found nothing left
    // to claim (already RUNNING/terminal by the time it tried).
    expect(outcomes).toEqual(['no_ready_task', 'ran_task'].sort());
    const linkedTasks = await db.task.findMany({ where: { sourceMissionTaskId: 'task_1' } });
    expect(linkedTasks).toHaveLength(1);
    const succeededEvents = (await db.missionEvent.findMany({ where: { missionId: 'mission_1' } })).filter(
      (e) => e.type === 'TASK_SUCCEEDED',
    );
    expect(succeededEvents).toHaveLength(1);
  });

  it('increments toolCallCount only for a task that actually names a tool, on every outcome', async () => {
    await seedActiveMission({ limits: { maxToolCalls: 500, maxTasks: 100, maxDurationDays: 180, maxRetries: 2, maxPublishPerWeek: 3, maxContentGenerationsPerWeek: 10 } });
    await db.missionTask.create({
      data: {
        id: 'task_1',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'No tool',
        description: 'd',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: [],
        status: 'PENDING',
      },
    });
    await runMissionTick('mission_1', asDb);
    const mission = await db.growthMission.findUnique({ where: { id: 'mission_1' } });
    // A pure human-decision task (no toolName) must never count as a tool call.
    expect(mission?.toolCallCount).toBe(0);
  });

  it('stops scheduling once the mission has hit its deadline', async () => {
    await seedActiveMission({ targetDate: new Date(Date.now() - 1000) });
    await db.missionTask.create({
      data: {
        id: 'task_1',
        missionId: 'mission_1',
        organizationId: 'org_1',
        title: 'Task',
        description: 'd',
        platform: 'CROSS_PLATFORM',
        toolName: null,
        dependsOnTaskIds: [],
        status: 'PENDING',
      },
    });
    const result = await runMissionTick('mission_1', asDb);
    expect(result.outcome).toBe('completed');
    expect(result.detail).toBe('DEADLINE_REACHED');
    const task1 = await db.missionTask.findUnique({ where: { id: 'task_1' } });
    // The task never ran — the mission stopped before scheduling it.
    expect(task1?.status).toBe('READY');
  });
});
