import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { createTaskFromRecommendation, updateTaskStatus } from './tasks.js';

const REC = {
  id: 'rec_1',
  organizationId: 'org_1',
  domain: 'SEO' as const,
  title: 'Fix canonical conflicts',
  explanation: 'Conflicting canonicals confuse crawlers.',
  implementationInstructions: 'Point each canonical at one indexable self-canonical URL.',
  priority: 'high',
  effort: 'small',
  confidence: 0.8,
  expectedImpact: 'Crawlers get one authoritative URL per page.',
  subjectRef: 'website_1',
  evidence: { affectedUrlSample: ['https://x.com/a', 'https://x.com/b'] },
};

function fakeDb() {
  const tasks: any[] = [];
  const memory: any[] = [];
  const audit: any[] = [];
  return {
    tasks,
    memory,
    audit,
    recommendation: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === REC.id && where.organizationId === REC.organizationId ? REC : null,
      ),
    },
    task: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `t${tasks.length}`, status: 'PENDING', completedAt: null, ...data };
        tasks.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: any) =>
          tasks.find((t) => t.id === where.id && t.organizationId === where.organizationId) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = tasks.find((t) => t.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    orgMemory: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        memory.push(data);
        return { id: `m${memory.length}`, ...data };
      }),
      update: vi.fn(async () => ({})),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audit.push(data);
        return {};
      }),
    },
  };
}

describe('createTaskFromRecommendation', () => {
  it('copies title, priority, instructions and affected URLs', async () => {
    const db = fakeDb();
    const task = await createTaskFromRecommendation(
      {
        organizationId: 'org_1',
        userId: 'u1',
        recommendationId: 'rec_1',
        sourceConversationId: 'c1',
      },
      db as never,
    );
    expect(task).toMatchObject({
      title: 'Fix canonical conflicts',
      priority: 'high',
      domain: 'SEO',
      sourceRecommendationId: 'rec_1',
      sourceConversationId: 'c1',
    });
    expect(task.affectedUrls).toEqual(['https://x.com/a', 'https://x.com/b']);
    expect(task.instructions).toMatch(/canonical/i);
    expect(db.audit.some((a) => a.action === 'task.created')).toBe(true);
  });

  it('refuses a recommendation from another org', async () => {
    const db = fakeDb();
    await expect(
      createTaskFromRecommendation(
        { organizationId: 'org_2', userId: 'u1', recommendationId: 'rec_1' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });
});

describe('updateTaskStatus', () => {
  it('sets completedAt and records a COMPLETED_TASK memory when moved to DONE', async () => {
    const db = fakeDb();
    const task = await createTaskFromRecommendation(
      { organizationId: 'org_1', userId: 'u1', recommendationId: 'rec_1' },
      db as never,
    );
    const updated = await updateTaskStatus(
      { organizationId: 'org_1', userId: 'u1', taskId: task.id, status: 'DONE' },
      db as never,
    );
    expect(updated.status).toBe('DONE');
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(db.memory.some((m) => m.kind === 'COMPLETED_TASK')).toBe(true);
    expect(db.audit.some((a) => a.action === 'task.status_changed')).toBe(true);
  });

  it('refuses a task from another org', async () => {
    const db = fakeDb();
    const task = await createTaskFromRecommendation(
      { organizationId: 'org_1', userId: 'u1', recommendationId: 'rec_1' },
      db as never,
    );
    await expect(
      updateTaskStatus(
        { organizationId: 'org_2', userId: 'u1', taskId: task.id, status: 'DONE' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });
});
