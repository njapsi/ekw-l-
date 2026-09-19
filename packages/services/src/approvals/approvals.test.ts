import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import type * as ActionsModule from '../wordpress/actions.js';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const executePublishPost = vi.fn(async (_ctx: unknown, _payload: unknown): Promise<unknown> => ({
  wpId: 5,
  status: 'publish',
}));
const executeUpdatePost = vi.fn(async (_ctx: unknown, _payload: unknown): Promise<unknown> => ({
  wpId: 5,
  status: 'draft',
}));

vi.mock('../wordpress/actions.js', async (importOriginal) => {
  const real = await importOriginal<typeof ActionsModule>();
  return { ...real, executePublishPost, executeUpdatePost };
});

const {
  cancelActionRequest,
  countPendingActions,
  decideActionRequest,
  expirePendingActions,
  requestIntegrationAction,
} = await import('./index.js');

let db: MemoryDb;
let asDb: Db;

async function site(caps: string[] = ['read', 'edit_posts', 'publish_posts'], status = 'ACTIVE') {
  return db.wordPressSite.create({
    data: {
      organizationId: 'org_1',
      siteUrl: 'https://blog.example.com',
      username: 'editor',
      credentialCipher: 'c',
      credentialIv: 'i',
      credentialAuthTag: 't',
      keyId: 'k',
      status,
      detectedCapabilities: caps,
      lastCheckAt: new Date(),
      lastCheckOk: true,
    },
  });
}

function publishRequest(connectionRef: string, over: Record<string, unknown> = {}) {
  return requestIntegrationAction(
    {
      organizationId: 'org_1',
      requestedById: 'u_member',
      capabilityId: 'wordpress.publish',
      connectionRef,
      payload: { wpId: 5 },
      summary: 'Publish "Launch post"',
      ...over,
    },
    asDb,
  );
}

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  executePublishPost.mockClear();
  executeUpdatePost.mockClear();
});

describe('requestIntegrationAction', () => {
  it('creates a PENDING request and never executes anything', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    expect(row.status).toBe('PENDING');
    expect(row.level).toBe('PUBLISH');
    expect(executePublishPost).not.toHaveBeenCalled();
    expect(await countPendingActions('org_1', asDb)).toBe(1);
  });

  it('notifies the org that an approval is needed', async () => {
    const s = await site();
    await publishRequest(s.id as string);
    expect(db.notification.rows[0]?.kind).toBe('integration.approval_needed');
  });

  it('refuses capabilities that have no executor (nothing unknown can be requested)', async () => {
    const s = await site();
    await expect(
      publishRequest(s.id as string, { capabilityId: 'wordpress.delete_everything' }),
    ).rejects.toThrow(/not an action/);
  });

  it('refuses when the connected WordPress user lacks the capability', async () => {
    const s = await site(['read', 'edit_posts']);
    await expect(publishRequest(s.id as string)).rejects.toThrow(/publish_posts/);
    expect(db.integrationActionRequest.rows).toHaveLength(0);
  });

  it('refuses when the connection needs reconnecting', async () => {
    const s = await site(undefined, 'EXPIRED');
    await expect(publishRequest(s.id as string)).rejects.toThrow();
  });

  it('refuses another organization’s connection', async () => {
    const s = await site();
    await expect(publishRequest(s.id as string, { organizationId: 'org_2' })).rejects.toThrow(
      /not found/,
    );
  });

  it('validates the payload before storing it', async () => {
    const s = await site();
    await expect(publishRequest(s.id as string, { payload: { wpId: -1 } })).rejects.toThrow();
    expect(db.integrationActionRequest.rows).toHaveLength(0);
  });

  it('scrubs secrets out of the summary', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string, {
      summary: 'Publish with key sk_live_abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(row.summary).not.toContain('sk_live_abcdefghijklmnop');
  });
});

describe('decideActionRequest', () => {
  it('approve executes exactly once, even if approved twice', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    const done = await decideActionRequest(
      { organizationId: 'org_1', deciderId: 'u_admin', requestId: row.id, decision: 'approve' },
      asDb,
    );
    expect(done.status).toBe('EXECUTED');
    await expect(
      decideActionRequest(
        { organizationId: 'org_1', deciderId: 'u_admin2', requestId: row.id, decision: 'approve' },
        asDb,
      ),
    ).rejects.toThrow(/already/);
    expect(executePublishPost).toHaveBeenCalledTimes(1);
  });

  it('concurrent approvals execute once', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    const results = await Promise.allSettled([
      decideActionRequest(
        { organizationId: 'org_1', deciderId: 'a', requestId: row.id, decision: 'approve' },
        asDb,
      ),
      decideActionRequest(
        { organizationId: 'org_1', deciderId: 'b', requestId: row.id, decision: 'approve' },
        asDb,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(executePublishPost).toHaveBeenCalledTimes(1);
  });

  it('reject never executes', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    const done = await decideActionRequest(
      { organizationId: 'org_1', deciderId: 'u_admin', requestId: row.id, decision: 'reject' },
      asDb,
    );
    expect(done.status).toBe('REJECTED');
    expect(executePublishPost).not.toHaveBeenCalled();
  });

  it('an expired request cannot be approved', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    await db.integrationActionRequest.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      decideActionRequest(
        { organizationId: 'org_1', deciderId: 'u_admin', requestId: row.id, decision: 'approve' },
        asDb,
      ),
    ).rejects.toThrow(/expired/);
    expect(executePublishPost).not.toHaveBeenCalled();
    expect(await expirePendingActions(new Date(), asDb)).toBe(1);
  });

  it('re-checks permissions at execution time', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    // The WordPress user was downgraded after the request was made.
    await db.wordPressSite.update({
      where: { id: s.id },
      data: { detectedCapabilities: ['read'] },
    });
    const done = await decideActionRequest(
      { organizationId: 'org_1', deciderId: 'u_admin', requestId: row.id, decision: 'approve' },
      asDb,
    );
    expect(done.status).toBe('FAILED');
    expect(executePublishPost).not.toHaveBeenCalled();
  });

  it('records a failed execution with a readable error', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    executePublishPost.mockRejectedValueOnce(new Error('WordPress 500 internal_server_error'));
    const done = await decideActionRequest(
      { organizationId: 'org_1', deciderId: 'u_admin', requestId: row.id, decision: 'approve' },
      asDb,
    );
    expect(done.status).toBe('FAILED');
    expect(done.error).toContain('internal_server_error');
  });

  it('cannot decide another organization’s request', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    await expect(
      decideActionRequest(
        { organizationId: 'org_2', deciderId: 'x', requestId: row.id, decision: 'approve' },
        asDb,
      ),
    ).rejects.toThrow(/not found/);
    expect(executePublishPost).not.toHaveBeenCalled();
  });
});

describe('cancelActionRequest', () => {
  it('only the requester (or an admin) can cancel', async () => {
    const s = await site();
    const row = await publishRequest(s.id as string);
    await expect(
      cancelActionRequest(
        { organizationId: 'org_1', userId: 'someone_else', requestId: row.id, isAdmin: false },
        asDb,
      ),
    ).rejects.toThrow();
    await cancelActionRequest(
      { organizationId: 'org_1', userId: 'u_member', requestId: row.id, isAdmin: false },
      asDb,
    );
    expect(db.integrationActionRequest.rows[0]?.status).toBe('CANCELLED');
  });
});
