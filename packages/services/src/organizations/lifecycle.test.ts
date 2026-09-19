import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';

vi.mock('@growth-agent/db', () => ({
  prisma: {},
  requireMembership: vi.fn(async (userId: string) => ({
    userId,
    organizationId: 'o1',
    role: 'OWNER',
    status: 'ACTIVE',
  })),
}));
vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../notifications/index.js', () => ({ createNotification: vi.fn(async () => 'n1') }));

const {
  requestOrganizationDeletion,
  cancelOrganizationDeletion,
  purgeOrganization,
  requestAccountDeletion,
} = await import('./lifecycle.js');

function fakeDb(over: Partial<Record<string, unknown>> = {}) {
  const org: Record<string, unknown> = {
    id: 'o1',
    name: 'Acme',
    deletionScheduledAt: null,
    deletionRequestedById: null,
  };
  const state = {
    org,
    membershipCount: 2,
    ownerMemberships: [] as Array<{ organizationId: string }>,
    otherOwners: 1,
    user: { id: 'u1', deletedAt: null, deletionScheduledAt: null } as Record<string, unknown>,
    ...over,
  };
  const db = {
    organization: {
      findUnique: vi.fn(async () => state.org),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.org, data);
        return state.org;
      }),
      delete: vi.fn(async () => state.org),
    },
    membership: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        'role' in where && where.role === 'OWNER' ? state.otherOwners : state.membershipCount,
      ),
      findMany: vi.fn(async () => state.ownerMemberships),
    },
    // Phase 2 deletion handling: pending approvals, paid plan, upstream creds.
    integrationActionRequest: { updateMany: vi.fn(async () => ({ count: 0 })) },
    subscription: { findUnique: vi.fn(async () => null) },
    oAuthConnection: { findMany: vi.fn(async () => []) },
    wordPressSite: { findMany: vi.fn(async () => []) },
    securityEvent: { create: vi.fn(async () => ({})) },
    userSession: { updateMany: vi.fn(async () => ({ count: 0 })) },
    user: {
      findUnique: vi.fn(async () => state.user),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.user, data);
        return state.user;
      }),
    },
  };
  return { db: db as unknown as Db, state };
}

beforeEach(() => vi.clearAllMocks());

describe('organization deletion', () => {
  it('refuses when it is the actor’s only organization', async () => {
    const { db } = fakeDb({ membershipCount: 1 });
    await expect(
      requestOrganizationDeletion({ actorUserId: 'u1', organizationId: 'o1' }, db),
    ).rejects.toThrow(/only organization/i);
  });

  it('schedules deletion and can be cancelled within grace', async () => {
    const { db, state } = fakeDb();
    const res = await requestOrganizationDeletion({ actorUserId: 'u1', organizationId: 'o1' }, db);
    expect(res.purgeAt).toBeTruthy();
    expect(state.org.deletionScheduledAt).toBeInstanceOf(Date);

    await cancelOrganizationDeletion({ actorUserId: 'u1', organizationId: 'o1' }, db);
    expect(state.org.deletionScheduledAt).toBeNull();
  });

  it('purge is a no-op until the grace window elapses, then deletes', async () => {
    const future = fakeDb({
      org: { id: 'o1', name: 'Acme', deletionScheduledAt: new Date(Date.now() + 1e6) },
    });
    expect(await purgeOrganization('o1', future.db)).toBe(false);
    expect(future.db.organization.delete).not.toHaveBeenCalled();

    const past = fakeDb({
      org: { id: 'o1', name: 'Acme', deletionScheduledAt: new Date(Date.now() - 1e6) },
    });
    expect(await purgeOrganization('o1', past.db)).toBe(true);
    expect(past.db.organization.delete).toHaveBeenCalledWith({ where: { id: 'o1' } });
  });
});

describe('account deletion', () => {
  it('bumps sessionVersion and cascades orgs where the user is the sole owner', async () => {
    const { db, state } = fakeDb({
      ownerMemberships: [{ organizationId: 'o1' }],
      otherOwners: 0,
    });
    const res = await requestAccountDeletion('u1', db);
    expect(res.cascadedOrganizationIds).toEqual(['o1']);
    expect(state.user.deletionScheduledAt).toBeInstanceOf(Date);
    // sessionVersion is bumped (signs every session out)…
    expect(state.user.sessionVersion).toEqual({ increment: 1 });
    // …but deletedAt is NOT set yet — the user can sign back in to cancel.
    expect(state.user.deletedAt).toBeNull();
  });
});
