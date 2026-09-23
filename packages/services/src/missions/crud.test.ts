import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

// `planMission` calls `checkRateLimit` (Phase 12's replan throttle), which
// otherwise attempts a real Redis connection with a 3s `connectTimeout`
// before falling back open — harmless in production (Redis is actually
// there), but in a test environment with no Redis this made every test
// that plans a mission occasionally exceed vitest's 5s default timeout
// under system load (reproduced repeatedly as a "flaky" failure before
// this was root-caused). Mock the client the same way
// `security/rate-limit.test.ts` already does, so tests never depend on
// real network behavior.
const fakeRedis = {
  status: 'ready' as string,
  connect: vi.fn(async () => undefined),
  incr: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
};
vi.mock('../observability/redis.js', () => ({
  getObservabilityRedis: () => fakeRedis,
}));

const {
  activateMission,
  cancelMission,
  createMission,
  getMission,
  pauseMission,
  planMission,
  resumeMission,
} = await import('./crud.js');

let db: MemoryDb;
let asDb: Db;

async function seedOrgAndMember(role: 'MEMBER' | 'VIEWER' = 'MEMBER') {
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
  await db.user.create({ data: { id: 'user_1', email: 'u@example.com' } });
  await db.membership.create({ data: { userId: 'user_1', organizationId: 'org_1', role, status: 'ACTIVE' } });
}

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

describe('createMission', () => {
  it('creates a DRAFT mission for a MEMBER-role caller', async () => {
    await seedOrgAndMember('MEMBER');
    const mission = await createMission(
      { organizationId: 'org_1', userId: 'user_1', input: { name: 'Grow traffic', objective: 'Grow organic traffic' } },
      asDb,
    );
    expect(mission.status).toBe('DRAFT');
    expect(mission.autonomyLevel).toBe('ASSISTED');
    expect(mission.allowedPlatforms).toEqual(['CROSS_PLATFORM']);
  });

  it('refuses a VIEWER-role caller — mission.manage is MEMBER+', async () => {
    await seedOrgAndMember('VIEWER');
    await expect(
      createMission({ organizationId: 'org_1', userId: 'user_1', input: { name: 'X', objective: 'Y' } }, asDb),
    ).rejects.toThrow();
  });

  it('refuses a caller who is no longer a member of the organization', async () => {
    await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
    await expect(
      createMission({ organizationId: 'org_1', userId: 'ghost', input: { name: 'X', objective: 'Y' } }, asDb),
    ).rejects.toThrow(/no longer a member/);
  });

  it('rejects an invalid input payload rather than silently coercing it', async () => {
    await seedOrgAndMember();
    await expect(
      createMission({ organizationId: 'org_1', userId: 'user_1', input: { name: '', objective: '' } }, asDb),
    ).rejects.toThrow();
  });
});

describe('mission lifecycle: plan → activate → pause → resume → cancel', () => {
  beforeEach(async () => {
    await seedOrgAndMember();
  });

  it('cannot be activated before it has a plan (AWAITING_APPROVAL)', async () => {
    const mission = await createMission(
      { organizationId: 'org_1', userId: 'user_1', input: { name: 'M', objective: 'Grow' } },
      asDb,
    );
    await expect(
      activateMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb),
    ).rejects.toThrow(/reviewed plan/);
  });

  it('planning with nothing connected produces an honest empty plan, not a fabricated one', async () => {
    const mission = await createMission(
      { organizationId: 'org_1', userId: 'user_1', input: { name: 'M', objective: 'Grow' } },
      asDb,
    );
    const planned = await planMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb);
    expect(planned.status).toBe('AWAITING_APPROVAL');
    expect(planned.taskCount).toBe(0);
    const strategy = planned.currentStrategy as { risks: string[] };
    expect(strategy.risks.join(' ')).toMatch(/no connected platform/i);
  });

  it('activate → pause → resume → cancel each enforce their own precondition', async () => {
    const mission = await createMission(
      { organizationId: 'org_1', userId: 'user_1', input: { name: 'M', objective: 'Grow' } },
      asDb,
    );
    await planMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb);
    const active = await activateMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb);
    expect(active.status).toBe('ACTIVE');

    // Cannot activate twice.
    await expect(
      activateMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb),
    ).rejects.toThrow();

    const paused = await pauseMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb);
    expect(paused.status).toBe('PAUSED');

    // Cannot pause an already-paused mission.
    await expect(
      pauseMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb),
    ).rejects.toThrow();

    const resumed = await resumeMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb);
    expect(resumed.status).toBe('ACTIVE');

    const cancelled = await cancelMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb);
    expect(cancelled.status).toBe('CANCELLED');

    // A cancelled mission stays queryable — history is never deleted (§50).
    const stillThere = await getMission('org_1', mission.id, asDb);
    expect(stillThere.status).toBe('CANCELLED');

    // Cannot resume/cancel again from a terminal state.
    await expect(
      resumeMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb),
    ).rejects.toThrow();
    await expect(
      cancelMission({ organizationId: 'org_1', userId: 'user_1', missionId: mission.id }, asDb),
    ).rejects.toThrow();
  });

  it('flags, but does not block, activating a mission whose platforms overlap another active one', async () => {
    const m1 = await createMission(
      { organizationId: 'org_1', userId: 'user_1', input: { name: 'M1', objective: 'Grow YT', platforms: ['YOUTUBE'] } },
      asDb,
    );
    await planMission({ organizationId: 'org_1', userId: 'user_1', missionId: m1.id }, asDb);
    await activateMission({ organizationId: 'org_1', userId: 'user_1', missionId: m1.id }, asDb);

    const m2 = await createMission(
      { organizationId: 'org_1', userId: 'user_1', input: { name: 'M2', objective: 'Grow YT too', platforms: ['YOUTUBE'] } },
      asDb,
    );
    await planMission({ organizationId: 'org_1', userId: 'user_1', missionId: m2.id }, asDb);
    // Activation itself must not throw — a conflict is flagged, not blocked.
    const activated = await activateMission({ organizationId: 'org_1', userId: 'user_1', missionId: m2.id }, asDb);
    expect(activated.status).toBe('ACTIVE');

    const events = await db.missionEvent.findMany({ where: { missionId: m2.id, type: 'CONFLICT_DETECTED' } });
    expect(events).toHaveLength(1);
  });
});
