import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, Role } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

vi.mock('../notifications/email.js', () => ({
  emailDeliveryConfigured: () => true,
  sendTransactionalEmail: vi.fn(async () => true),
}));

const m = await import('./members.js');

let db: MemoryDb;
let asDb: Db;
const ORG = 'org_1';
const opts = () => ({ appUrl: 'https://app.example.com', db: asDb });

async function member(userId: string, role: Role, email = `${userId}@example.com`, org = ORG) {
  await db.user.create({ data: { id: userId, email } });
  return db.membership.create({
    data: { userId, organizationId: org, role, status: 'ACTIVE', user: { email } },
  });
}

async function roleOf(userId: string) {
  const r = await db.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: ORG } },
  });
  return r?.role;
}

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: ORG, name: 'Acme', slug: 'acme' } });
});

describe('role changes (no privilege escalation)', () => {
  it('an ADMIN cannot promote anyone — including themselves — to OWNER', async () => {
    await member('owner', 'OWNER');
    await member('admin', 'ADMIN');
    await member('mem', 'MEMBER');
    await expect(
      m.updateMemberRole('admin', ORG, { targetUserId: 'mem', role: 'OWNER' }, asDb),
    ).rejects.toThrow(/Only an owner/);
    await expect(
      m.updateMemberRole('admin', ORG, { targetUserId: 'admin', role: 'OWNER' }, asDb),
    ).rejects.toThrow(/your own role/);
    expect(await roleOf('mem')).toBe('MEMBER');
    expect(db.auditLog.rows.some((a) => a.result === 'DENIED')).toBe(true);
  });

  it('an ADMIN cannot demote an OWNER', async () => {
    await member('owner', 'OWNER');
    await member('admin', 'ADMIN');
    await expect(
      m.updateMemberRole('admin', ORG, { targetUserId: 'owner', role: 'VIEWER' }, asDb),
    ).rejects.toThrow(/Only an owner/);
    expect(await roleOf('owner')).toBe('OWNER');
  });

  it('a MANAGER cannot change roles at all', async () => {
    await member('mgr', 'MANAGER');
    await member('v', 'VIEWER');
    await expect(
      m.updateMemberRole('mgr', ORG, { targetUserId: 'v', role: 'MEMBER' }, asDb),
    ).rejects.toThrow();
  });

  it('an ADMIN can move people between non-owner roles and it is audited', async () => {
    await member('admin', 'ADMIN');
    await member('v', 'VIEWER');
    await m.updateMemberRole('admin', ORG, { targetUserId: 'v', role: 'MANAGER' }, asDb);
    expect(await roleOf('v')).toBe('MANAGER');
    expect(db.auditLog.rows.some((a) => a.action === 'member.role_changed')).toBe(true);
  });

  it('raising someone to ADMIN records a ROLE_ESCALATION security event', async () => {
    await member('owner', 'OWNER');
    await member('v', 'VIEWER');
    await m.updateMemberRole('owner', ORG, { targetUserId: 'v', role: 'ADMIN' }, asDb);
    expect(
      db.securityEvent.rows.some((e) => e.type === 'ROLE_ESCALATION' && e.userId === 'v'),
    ).toBe(true);
  });

  it('the last owner cannot step down', async () => {
    await member('owner', 'OWNER');
    await expect(
      m.updateMemberRole('owner', ORG, { targetUserId: 'owner', role: 'ADMIN' }, asDb),
    ).rejects.toThrow(/at least one owner/);
  });

  it('ownership transfer swaps OWNER and ADMIN atomically', async () => {
    await member('owner', 'OWNER');
    await member('admin', 'ADMIN');
    await m.transferOwnership('owner', ORG, 'admin', asDb);
    expect(await roleOf('admin')).toBe('OWNER');
    expect(await roleOf('owner')).toBe('ADMIN');
  });

  it('only an OWNER can transfer ownership', async () => {
    await member('owner', 'OWNER');
    await member('admin', 'ADMIN');
    await expect(m.transferOwnership('admin', ORG, 'admin', asDb)).rejects.toThrow();
  });
});

describe('removing members', () => {
  it('an ADMIN cannot remove an OWNER', async () => {
    await member('owner', 'OWNER');
    await member('admin', 'ADMIN');
    await expect(m.removeMember('admin', ORG, 'owner', asDb)).rejects.toThrow(/owner/);
  });

  it('the last owner cannot leave', async () => {
    await member('owner', 'OWNER');
    await expect(m.removeMember('owner', ORG, 'owner', asDb)).rejects.toThrow(/at least one owner/);
  });

  it('anyone can leave; the removal is audited', async () => {
    await member('owner', 'OWNER');
    await member('v', 'VIEWER');
    await m.removeMember('v', ORG, 'v', asDb);
    expect(await roleOf('v')).toBeUndefined();
    expect(db.auditLog.rows.some((a) => a.action === 'member.left')).toBe(true);
  });
});

describe('invitations', () => {
  it('OWNER cannot be invited; a MANAGER cannot invite', async () => {
    await member('owner', 'OWNER');
    await member('mgr', 'MANAGER');
    await expect(
      m.inviteMember('owner', ORG, { email: 'x@example.com', role: 'OWNER' }, opts()),
    ).rejects.toThrow(/Owners cannot be invited/);
    await expect(
      m.inviteMember('mgr', ORG, { email: 'x@example.com', role: 'VIEWER' }, opts()),
    ).rejects.toThrow();
  });

  it('inviting an existing member is refused', async () => {
    await member('owner', 'OWNER');
    await member('v', 'VIEWER', 'v@example.com');
    await expect(
      m.inviteMember('owner', ORG, { email: 'V@example.com', role: 'MEMBER' }, opts()),
    ).rejects.toThrow(/already a member/);
  });

  it('stores only a hash of the token and emails the link', async () => {
    await member('owner', 'OWNER');
    const res = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MEMBER' },
      opts(),
    );
    expect(res.emailed).toBe(true);
    expect(JSON.stringify(db.invitation.rows)).not.toContain(res.token);
    expect(db.invitation.rows[0]?.tokenHash).toBe(m.hashInviteToken(res.token));
  });

  it('re-inviting rotates the token: the old link stops working', async () => {
    await member('owner', 'OWNER');
    const first = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MEMBER' },
      opts(),
    );
    const second = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MEMBER' },
      opts(),
    );
    expect(db.invitation.rows).toHaveLength(1);
    await db.user.create({ data: { id: 'newbie', email: 'new@example.com' } });
    await expect(
      m.acceptInvitation('newbie', 'new@example.com', first.token, asDb),
    ).rejects.toThrow(/invalid, expired or has already been used/);
    await m.acceptInvitation('newbie', 'new@example.com', second.token, asDb);
  });

  it('accepting joins with the invited role and cannot be reused', async () => {
    await member('owner', 'OWNER');
    const { token } = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MANAGER' },
      opts(),
    );
    await db.user.create({ data: { id: 'newbie', email: 'new@example.com' } });
    const joined = await m.acceptInvitation('newbie', 'new@example.com', token, asDb);
    expect(joined.role).toBe('MANAGER');
    await expect(m.acceptInvitation('newbie', 'new@example.com', token, asDb)).rejects.toThrow();
  });

  it('refuses a different email address', async () => {
    await member('owner', 'OWNER');
    const { token } = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MEMBER' },
      opts(),
    );
    await expect(m.acceptInvitation('other', 'other@example.com', token, asDb)).rejects.toThrow(
      /different email/,
    );
  });

  it('refuses an expired or revoked invitation with the same generic message', async () => {
    await member('owner', 'OWNER');
    const a = await m.inviteMember(
      'owner',
      ORG,
      { email: 'a@example.com', role: 'MEMBER' },
      opts(),
    );
    await db.invitation.update({
      where: { id: a.invitationId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(m.acceptInvitation('ua', 'a@example.com', a.token, asDb)).rejects.toThrow(
      /invalid, expired or has already been used/,
    );
    const b = await m.inviteMember(
      'owner',
      ORG,
      { email: 'b@example.com', role: 'MEMBER' },
      opts(),
    );
    await m.revokeInvitation('owner', ORG, b.invitationId, asDb);
    await expect(m.acceptInvitation('ub', 'b@example.com', b.token, asDb)).rejects.toThrow(
      /invalid, expired or has already been used/,
    );
  });

  it('an unknown token reveals nothing', async () => {
    await expect(m.acceptInvitation('u', 'u@example.com', 'nope', asDb)).rejects.toThrow(
      /invalid, expired or has already been used/,
    );
    expect(await m.previewInvitation('nope', asDb)).toBeNull();
  });

  it('an invitation dies when the inviter loses the right to grant that role', async () => {
    await member('owner', 'OWNER');
    await member('admin', 'ADMIN');
    const { token } = await m.inviteMember(
      'admin',
      ORG,
      { email: 'new@example.com', role: 'ADMIN' },
      opts(),
    );
    await m.updateMemberRole('owner', ORG, { targetUserId: 'admin', role: 'MEMBER' }, asDb);
    await expect(m.acceptInvitation('newbie', 'new@example.com', token, asDb)).rejects.toThrow(
      /invalid, expired or has already been used/,
    );
  });

  it('an invitation to an organization being deleted is invalid', async () => {
    await member('owner', 'OWNER');
    const { token } = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MEMBER' },
      opts(),
    );
    await db.organization.update({ where: { id: ORG }, data: { deletionScheduledAt: new Date() } });
    await expect(m.acceptInvitation('newbie', 'new@example.com', token, asDb)).rejects.toThrow();
  });

  it('concurrent accepts of one token create one membership', async () => {
    await member('owner', 'OWNER');
    const { token } = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MEMBER' },
      opts(),
    );
    const results = await Promise.allSettled([
      m.acceptInvitation('newbie', 'new@example.com', token, asDb),
      m.acceptInvitation('newbie', 'new@example.com', token, asDb),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('resend is capped', async () => {
    await member('owner', 'OWNER');
    const { invitationId } = await m.inviteMember(
      'owner',
      ORG,
      { email: 'new@example.com', role: 'MEMBER' },
      opts(),
    );
    for (let i = 1; i < m.MAX_INVITE_SENDS; i++)
      await m.resendInvitation('owner', ORG, invitationId, opts());
    await expect(m.resendInvitation('owner', ORG, invitationId, opts())).rejects.toThrow(
      /too many times/,
    );
  });

  it('an invitation from another organization cannot be revoked here', async () => {
    await member('owner', 'OWNER');
    await db.organization.create({ data: { id: 'org_2', name: 'Other', slug: 'other' } });
    await member('owner2', 'OWNER', 'o2@example.com', 'org_2');
    const res = await m.inviteMember(
      'owner2',
      'org_2',
      { email: 'x@example.com', role: 'MEMBER' },
      opts(),
    );
    await expect(m.revokeInvitation('owner', ORG, res.invitationId, asDb)).rejects.toThrow(
      /not found/,
    );
  });
});
