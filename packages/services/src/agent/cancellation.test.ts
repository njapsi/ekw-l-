import { describe, expect, it, vi } from 'vitest';
import { cancelAgentRun } from './cancellation.js';
import { isAppError } from '../errors.js';

function fakeDb(run: {
  id: string;
  organizationId: string;
  userId: string | null;
  status: string;
}) {
  const row: typeof run & { cancelledAt?: Date; finishedAt?: Date; currentStep?: string } = {
    ...run,
  };
  return {
    agentRun: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === row.id && where.organizationId === row.organizationId ? { ...row } : null,
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.id !== row.id || where.organizationId !== row.organizationId) return { count: 0 };
        if (!where.status.in.includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    agentRunEvent: { create: vi.fn(async () => ({})) },
    _row: row,
  };
}

describe('cancelAgentRun', () => {
  it('cancels a RUNNING run owned by the caller and records RUN_CANCELLED', async () => {
    const db = fakeDb({
      id: 'run_1',
      organizationId: 'org_1',
      userId: 'user_1',
      status: 'RUNNING',
    });
    const result = await cancelAgentRun(
      { organizationId: 'org_1', userId: 'user_1', agentRunId: 'run_1' },
      db as never,
    );
    expect(result.cancelled).toBe(true);
    expect(db._row.status).toBe('CANCELLED');
    expect(db._row.cancelledAt).toBeInstanceOf(Date);
    expect(db.agentRunEvent.create).toHaveBeenCalledTimes(1);
  });

  it('is a no-op, not an error, for a run that already finished', async () => {
    const db = fakeDb({
      id: 'run_1',
      organizationId: 'org_1',
      userId: 'user_1',
      status: 'COMPLETED',
    });
    const result = await cancelAgentRun(
      { organizationId: 'org_1', userId: 'user_1', agentRunId: 'run_1' },
      db as never,
    );
    expect(result.cancelled).toBe(false);
    expect(db._row.status).toBe('COMPLETED');
    expect(db.agentRunEvent.create).not.toHaveBeenCalled();
  });

  it('refuses to cancel another user’s run', async () => {
    const db = fakeDb({ id: 'run_1', organizationId: 'org_1', userId: 'owner', status: 'RUNNING' });
    await expect(
      cancelAgentRun(
        { organizationId: 'org_1', userId: 'someone_else', agentRunId: 'run_1' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'permission_denied');
    expect(db._row.status).toBe('RUNNING');
  });

  it('refuses a run from another organization — never trusts the client’s org id alone', async () => {
    const db = fakeDb({
      id: 'run_1',
      organizationId: 'org_1',
      userId: 'user_1',
      status: 'RUNNING',
    });
    await expect(
      cancelAgentRun(
        { organizationId: 'org_evil', userId: 'user_1', agentRunId: 'run_1' },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });
});
