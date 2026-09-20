import { describe, expect, it, vi } from 'vitest';
import { listAgentRunEvents, recordAgentRunEvent } from './events.js';

describe('recordAgentRunEvent', () => {
  it('scrubs secret-shaped metadata before writing', async () => {
    const create = vi.fn(async (_args: { data: { metadata?: { note?: string } } }) => ({}));
    const db = { agentRunEvent: { create } } as never;
    await recordAgentRunEvent(
      {
        agentRunId: 'run_1',
        organizationId: 'org_1',
        type: 'TOOL_COMPLETED',
        metadata: { note: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL' },
      },
      db,
    );
    const data = create.mock.calls[0]![0].data;
    expect(data.metadata?.note).not.toContain('sk-ant-api03');
  });

  it('never throws into the caller when the write fails', async () => {
    const db = {
      agentRunEvent: {
        create: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    } as never;
    await expect(
      recordAgentRunEvent({ agentRunId: 'run_1', organizationId: 'org_1', type: 'RUN_FAILED' }, db),
    ).resolves.toBeUndefined();
  });
});

describe('listAgentRunEvents', () => {
  it('is tenant-scoped by both agentRunId and organizationId', async () => {
    const findMany = vi.fn(async (_args: { where: unknown }) => [] as unknown[]);
    const db = { agentRunEvent: { findMany } } as never;
    await listAgentRunEvents('org_1', 'run_1', db);
    expect(findMany.mock.calls[0]![0].where).toEqual({
      agentRunId: 'run_1',
      organizationId: 'org_1',
    });
  });
});
