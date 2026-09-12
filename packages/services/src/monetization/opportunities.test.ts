import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import {
  listOpportunities,
  promoteOpportunityToTask,
  updateOpportunityStatus,
} from './opportunities.js';

function fakeDb() {
  const opp: any = {
    id: 'op1',
    organizationId: 'org_1',
    channel: 'SPONSORSHIP',
    title: 'Sponsorships',
    description: 'Direct brand deals.',
    status: 'SUGGESTED',
    evidence: [],
    audienceFit: 'moderate',
    difficulty: 'medium',
    potential: 'Moderate',
    potentialBasis: 'Estimate only. Not a revenue figure.',
    requiredActions: ['Build a media kit', 'List 20 brands'],
    confidence: 0.6,
    priorityScore: 70,
    dismissedReason: null,
    completedNote: null,
  };
  const tasks: any[] = [];
  const audit: any[] = [];
  return {
    opp,
    tasks,
    audit,
    monetizationOpportunity: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === opp.id && where.organizationId === opp.organizationId ? opp : null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        where.organizationId === opp.organizationId &&
        (!where.status || where.status === opp.status)
          ? [opp]
          : [],
      ),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(opp, data);
        return opp;
      }),
    },
    task: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `t${tasks.length + 1}`, ...data };
        tasks.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audit.push(data);
        return {};
      }),
    },
  };
}

const base = { organizationId: 'org_1', userId: 'u1', opportunityId: 'op1' };

describe('opportunity lifecycle', () => {
  it('moves through statuses and records a dismiss reason', async () => {
    const db = fakeDb();
    await updateOpportunityStatus({ ...base, status: 'IN_PROGRESS' }, db as never);
    expect(db.opp.status).toBe('IN_PROGRESS');
    await updateOpportunityStatus(
      { ...base, status: 'DISMISSED', reason: 'Not a fit for my audience' },
      db as never,
    );
    expect(db.opp.status).toBe('DISMISSED');
    expect(db.opp.dismissedReason).toBe('Not a fit for my audience');
    expect(
      db.audit.filter((a) => a.action === 'monetization.opportunity.status_changed'),
    ).toHaveLength(2);
  });

  it('promote-to-task creates a task from the required actions and flips SUGGESTED → IN_PROGRESS', async () => {
    const db = fakeDb();
    const task = await promoteOpportunityToTask(base, db as never);
    expect(task.title).toMatch(/Monetization: Sponsorships/);
    expect(task.instructions).toMatch(/1\. Build a media kit/);
    expect(db.opp.status).toBe('IN_PROGRESS');
    expect(db.audit.some((a) => a.action === 'monetization.opportunity.promoted')).toBe(true);
  });

  it('the promoted task never targets an external system', async () => {
    const db = fakeDb();
    await promoteOpportunityToTask(base, db as never);
    expect(db.tasks[0].requiresExternalAction ?? false).toBe(false);
  });

  it('is tenant-scoped', async () => {
    const db = fakeDb();
    await expect(
      updateOpportunityStatus(
        { ...base, organizationId: 'org_2', status: 'COMPLETED' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
    await expect(
      promoteOpportunityToTask({ ...base, organizationId: 'org_2' }, db as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });

  it('listOpportunities filters by status', async () => {
    const db = fakeDb();
    expect(await listOpportunities('org_1', {}, db as never)).toHaveLength(1);
    expect(await listOpportunities('org_1', { status: 'ACTIVE' }, db as never)).toHaveLength(0);
  });
});
