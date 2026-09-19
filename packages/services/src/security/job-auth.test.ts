import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { assertJobAuthorized } from './job-auth.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'o1', name: 'A', slug: 'a' } });
  await db.user.create({ data: { id: 'u1', email: 'u1@example.com' } });
  await db.membership.create({
    data: { userId: 'u1', organizationId: 'o1', role: 'MEMBER', status: 'ACTIVE' },
  });
});

const ctx = { organizationId: 'o1', actorUserId: 'u1', jobId: 'j1' };

describe('assertJobAuthorized (worker authorization)', () => {
  it('passes for an active member with the permission', async () => {
    await expect(assertJobAuthorized(ctx, 'agent.run', asDb)).resolves.toBeUndefined();
  });

  it('fails when the permission is missing', async () => {
    await expect(assertJobAuthorized(ctx, 'content.publish', asDb)).rejects.toThrow();
  });

  it('fails when the member was removed after enqueue', async () => {
    await db.membership.deleteMany({ where: { userId: 'u1' } });
    await expect(assertJobAuthorized(ctx, 'agent.run', asDb)).rejects.toThrow(/no longer active/);
  });

  it('fails when the member was demoted after enqueue', async () => {
    await db.membership.updateMany({ where: { userId: 'u1' }, data: { role: 'VIEWER' } });
    await expect(assertJobAuthorized(ctx, 'agent.run', asDb)).rejects.toThrow();
  });

  it('fails for a deactivated user', async () => {
    await db.user.update({ where: { id: 'u1' }, data: { deactivatedAt: new Date() } });
    await expect(assertJobAuthorized(ctx, 'agent.run', asDb)).rejects.toThrow(/no longer active/);
  });

  it('fails for an organization being deleted — even for system jobs', async () => {
    await db.organization.update({
      where: { id: 'o1' },
      data: { deletionScheduledAt: new Date() },
    });
    await expect(assertJobAuthorized({ ...ctx, actorUserId: null }, null, asDb)).rejects.toThrow(
      /being deleted/,
    );
  });

  it('fails for a job naming another organization the member does not belong to', async () => {
    await db.organization.create({ data: { id: 'o2', name: 'B', slug: 'b' } });
    await expect(
      assertJobAuthorized({ ...ctx, organizationId: 'o2' }, 'agent.run', asDb),
    ).rejects.toThrow();
  });
});
