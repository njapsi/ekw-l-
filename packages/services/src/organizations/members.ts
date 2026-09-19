/**
 * Members, roles and invitations (Phase 2, Parts 5–12).
 *
 * Every mutation here re-derives the actor's role from the database
 * (`requireMembership`) — never from the session or the request — and runs
 * the escalation rules in `rbac/permissions.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type Db, type Role, prisma, requireMembership } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';
import { runInTransaction } from '../db-tx.js';
import { AppError } from '../errors.js';
import { createNotification } from '../notifications/index.js';
import { emailDeliveryConfigured, sendTransactionalEmail } from '../notifications/email.js';
import { authorize } from '../rbac/authorize.js';
import {
  ROLE_RANK,
  canRemoveMember,
  checkRoleChange,
  invitableRoles,
  roleHasPermission,
} from '../rbac/permissions.js';
import { recordSecurityEvent } from '../security/events.js';

const log = createLogger('members');

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INVITE_SENDS = 5;

const ROLE_ENUM = z.enum(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER']);

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function actorMembership(actorUserId: string, organizationId: string, db: Db) {
  const m = await requireMembership(actorUserId, organizationId, db);
  return {
    membership: m,
    actor: { userId: actorUserId, role: m.role, membershipStatus: m.status },
  };
}

// --- Members ---------------------------------------------------------------

export async function listMembers(actorUserId: string, organizationId: string, db: Db = prisma) {
  const { actor } = await actorMembership(actorUserId, organizationId, db);
  authorize(actor, 'member.view');
  return db.membership.findMany({
    where: { organizationId },
    include: {
      user: { select: { id: true, name: true, email: true, image: true, lastActiveAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function assertNotLastOwner(organizationId: string, userId: string, db: Db) {
  const owners = await db.membership.count({
    where: { organizationId, role: 'OWNER', status: 'ACTIVE' },
  });
  const target = await db.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { role: true },
  });
  if (target?.role === 'OWNER' && owners <= 1) {
    throw AppError.conflict(
      'An organization must always have at least one owner. Make someone else an owner first.',
    );
  }
}

const DENIAL_MESSAGE: Record<string, string> = {
  not_permitted: 'Your role cannot change member roles.',
  owner_only: 'Only an owner can grant or remove the owner role.',
  target_outranks_actor: 'You cannot change the role of someone above you.',
  role_above_actor: 'You cannot assign a role higher than your own.',
  self_change: 'You cannot change your own role.',
};

export const updateMemberRoleInput = z.object({
  targetUserId: z.string().min(1),
  role: ROLE_ENUM,
});

export async function updateMemberRole(
  actorUserId: string,
  organizationId: string,
  raw: z.infer<typeof updateMemberRoleInput>,
  db: Db = prisma,
) {
  const input = updateMemberRoleInput.parse(raw);
  const { membership } = await actorMembership(actorUserId, organizationId, db);
  if (membership.status !== 'ACTIVE') throw AppError.forbidden('Your membership is not active.');

  const target = await db.membership.findUnique({
    where: { userId_organizationId: { userId: input.targetUserId, organizationId } },
  });
  if (!target) throw AppError.notFound('Member');
  if (target.role === input.role) return target;

  const denial = checkRoleChange({
    actorRole: membership.role,
    isSelf: input.targetUserId === actorUserId,
    from: target.role,
    to: input.role,
  });
  if (denial) {
    await recordAudit(
      {
        organizationId,
        actorId: actorUserId,
        action: 'member.role_change_denied',
        targetType: 'user',
        targetId: input.targetUserId,
        result: 'DENIED',
        metadata: { from: target.role, to: input.role, reason: denial },
      },
      db,
    );
    throw AppError.forbidden(DENIAL_MESSAGE[denial] ?? 'Not permitted.');
  }
  if (target.role === 'OWNER' && input.role !== 'OWNER') {
    await assertNotLastOwner(organizationId, input.targetUserId, db);
  }

  const updated = await db.membership.update({
    where: { userId_organizationId: { userId: input.targetUserId, organizationId } },
    data: { role: input.role },
  });

  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'member.role_changed',
      targetType: 'user',
      targetId: input.targetUserId,
      metadata: { from: target.role, to: input.role },
    },
    db,
  );
  if (ROLE_RANK[input.role] > ROLE_RANK[target.role] && ROLE_RANK[input.role] >= ROLE_RANK.ADMIN) {
    await recordSecurityEvent(
      {
        userId: input.targetUserId,
        organizationId,
        type: input.role === 'OWNER' ? 'OWNER_TRANSFER' : 'ROLE_ESCALATION',
        severity: 'WARNING',
        metadata: { from: target.role, to: input.role, by: actorUserId },
      },
      db,
    );
  }
  return updated;
}

/** Remove a member, or leave (actor === target). The last owner can do neither. */
export async function removeMember(
  actorUserId: string,
  organizationId: string,
  targetUserId: string,
  db: Db = prisma,
) {
  const { membership } = await actorMembership(actorUserId, organizationId, db);
  const target = await db.membership.findUnique({
    where: { userId_organizationId: { userId: targetUserId, organizationId } },
  });
  if (!target) throw AppError.notFound('Member');

  const leaving = actorUserId === targetUserId;
  if (!leaving && !canRemoveMember(membership.role, target.role)) {
    throw AppError.forbidden(
      target.role === 'OWNER'
        ? 'Only an owner can remove another owner.'
        : 'Your role cannot remove this member.',
    );
  }
  await assertNotLastOwner(organizationId, targetUserId, db);

  await db.membership.delete({
    where: { userId_organizationId: { userId: targetUserId, organizationId } },
  });
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: leaving ? 'member.left' : 'member.removed',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { role: target.role },
    },
    db,
  );
  await recordSecurityEvent(
    {
      userId: targetUserId,
      organizationId,
      type: 'MEMBER_REMOVED',
      metadata: { by: actorUserId, left: leaving },
    },
    db,
  );
}

/** OWNER hands ownership to another member and becomes an ADMIN. */
export async function transferOwnership(
  actorUserId: string,
  organizationId: string,
  targetUserId: string,
  db: Db = prisma,
) {
  const { actor } = await actorMembership(actorUserId, organizationId, db);
  authorize(actor, 'ownership.transfer');
  if (targetUserId === actorUserId) throw AppError.validation('You already own this organization.');
  const target = await db.membership.findUnique({
    where: { userId_organizationId: { userId: targetUserId, organizationId } },
  });
  if (!target || target.status !== 'ACTIVE') throw AppError.notFound('Member');

  await runInTransaction(db, async (tx) => {
    await tx.membership.update({
      where: { userId_organizationId: { userId: targetUserId, organizationId } },
      data: { role: 'OWNER' },
    });
    await tx.membership.update({
      where: { userId_organizationId: { userId: actorUserId, organizationId } },
      data: { role: 'ADMIN' },
    });
  });
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'organization.ownership_transferred',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { previousRole: target.role },
    },
    db,
  );
  await recordSecurityEvent(
    {
      userId: targetUserId,
      organizationId,
      type: 'OWNER_TRANSFER',
      severity: 'WARNING',
      metadata: { from: actorUserId },
    },
    db,
  );
}

// --- Invitations -------------------------------------------------------------

export const inviteMemberInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: ROLE_ENUM.default('MEMBER'),
});

export interface InviteResult {
  invitationId: string;
  /** The raw token — returned once so the UI can show a copyable link. */
  token: string;
  emailed: boolean;
}

function inviteEmail(orgName: string, role: Role, url: string) {
  const text = [
    `You have been invited to join ${orgName} on Growth Agent as ${role.toLowerCase()}.`,
    '',
    `Accept the invitation: ${url}`,
    '',
    'The link expires in 7 days and can be used once. If you were not expecting this, ignore this email.',
  ].join('\n');
  return { subject: `Join ${orgName} on Growth Agent`, text };
}

async function sendInvite(
  db: Db,
  args: { organizationId: string; email: string; role: Role; token: string; appUrl: string },
): Promise<boolean> {
  if (!emailDeliveryConfigured()) return false;
  const org = await db.organization.findUnique({
    where: { id: args.organizationId },
    select: { name: true },
  });
  const url = `${args.appUrl.replace(/\/$/, '')}/invite/${args.token}`;
  const mail = inviteEmail(org?.name ?? 'an organization', args.role, url);
  return sendTransactionalEmail({ to: args.email, ...mail });
}

export async function inviteMember(
  actorUserId: string,
  organizationId: string,
  raw: z.input<typeof inviteMemberInput>,
  opts: { appUrl: string; db?: Db },
): Promise<InviteResult> {
  const db = opts.db ?? prisma;
  const input = inviteMemberInput.parse(raw);
  const { membership, actor } = await actorMembership(actorUserId, organizationId, db);
  authorize(actor, 'member.invite');
  if (!invitableRoles(membership.role).includes(input.role)) {
    throw AppError.forbidden(
      input.role === 'OWNER'
        ? 'Owners cannot be invited. Invite as admin, then transfer ownership.'
        : 'You cannot invite someone with a role higher than your own.',
    );
  }

  const existingMember = await db.membership.findFirst({
    where: { organizationId, user: { email: input.email } },
    select: { id: true },
  });
  if (existingMember) throw AppError.conflict('That person is already a member.');

  const token = randomBytes(32).toString('base64url');
  const pending = await db.invitation.findFirst({
    where: { organizationId, email: input.email, acceptedAt: null, revokedAt: null },
    select: { id: true },
  });
  // One live invitation per address: re-inviting rotates the token (the old
  // link stops working) instead of piling up parallel valid links.
  const invitation = pending
    ? await db.invitation.update({
        where: { id: pending.id },
        data: {
          role: input.role,
          tokenHash: hashInviteToken(token),
          invitedById: actorUserId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          lastSentAt: new Date(),
          sendCount: 1,
        },
      })
    : await db.invitation.create({
        data: {
          organizationId,
          email: input.email,
          role: input.role,
          tokenHash: hashInviteToken(token),
          invitedById: actorUserId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          lastSentAt: new Date(),
        },
      });

  const emailed = await sendInvite(db, {
    organizationId,
    email: input.email,
    role: input.role,
    token,
    appUrl: opts.appUrl,
  });

  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'member.invited',
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: { email: input.email, role: input.role, emailed },
    },
    db,
  );
  await createNotification(
    {
      organizationId,
      kind: 'member.invited',
      level: 'INFO',
      title: 'Team invitation sent',
      body: `${input.email} was invited as ${input.role.toLowerCase()}.`,
      linkPath: '/app/settings/members',
      dedupeKey: `invite:${invitation.id}:${invitation.sendCount}:${Date.now()}`,
      sourceType: 'invitation',
      sourceId: invitation.id,
      email: false,
    },
    db,
  );
  return { invitationId: invitation.id, token, emailed };
}

export async function listInvitations(
  actorUserId: string,
  organizationId: string,
  db: Db = prisma,
) {
  const { actor } = await actorMembership(actorUserId, organizationId, db);
  authorize(actor, 'member.view');
  const rows = await db.invitation.findMany({
    where: { organizationId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      lastSentAt: true,
      sendCount: true,
      createdAt: true,
      invitedBy: { select: { name: true, email: true } },
    },
  });
  const now = Date.now();
  return rows.map((r) => ({ ...r, expired: r.expiresAt.getTime() <= now }));
}

export async function resendInvitation(
  actorUserId: string,
  organizationId: string,
  invitationId: string,
  opts: { appUrl: string; db?: Db },
): Promise<InviteResult> {
  const db = opts.db ?? prisma;
  const { membership, actor } = await actorMembership(actorUserId, organizationId, db);
  authorize(actor, 'member.invite');
  const inv = await db.invitation.findFirst({
    where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
  });
  if (!inv) throw AppError.notFound('Invitation');
  if (!invitableRoles(membership.role).includes(inv.role)) {
    throw AppError.forbidden('You cannot resend an invitation for a role higher than your own.');
  }
  if (inv.sendCount >= MAX_INVITE_SENDS) {
    throw AppError.conflict(
      'This invitation has been sent too many times. Revoke it and invite again.',
    );
  }
  const token = randomBytes(32).toString('base64url');
  await db.invitation.update({
    where: { id: inv.id },
    data: {
      tokenHash: hashInviteToken(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      lastSentAt: new Date(),
      sendCount: inv.sendCount + 1,
    },
  });
  const emailed = await sendInvite(db, {
    organizationId,
    email: inv.email,
    role: inv.role,
    token,
    appUrl: opts.appUrl,
  });
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'member.invitation_resent',
      targetType: 'invitation',
      targetId: inv.id,
      metadata: { email: inv.email, emailed },
    },
    db,
  );
  return { invitationId: inv.id, token, emailed };
}

export async function revokeInvitation(
  actorUserId: string,
  organizationId: string,
  invitationId: string,
  db: Db = prisma,
) {
  const { actor } = await actorMembership(actorUserId, organizationId, db);
  authorize(actor, 'member.invite');
  const res = await db.invitation.updateMany({
    where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (res.count === 0) throw AppError.notFound('Invitation');
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'member.invitation_revoked',
      targetType: 'invitation',
      targetId: invitationId,
    },
    db,
  );
}

const INVALID_INVITE = 'This invitation link is invalid, expired or has already been used.';

/**
 * What the accept page may show. Deliberately minimal and identical for every
 * failure reason, so a token cannot be probed for state.
 */
export async function previewInvitation(token: string, db: Db = prisma) {
  const inv = await db.invitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      organization: { select: { name: true, deletedAt: true, deletionScheduledAt: true } },
      invitedBy: { select: { name: true } },
    },
  });
  if (
    !inv ||
    inv.acceptedAt ||
    inv.revokedAt ||
    inv.expiresAt.getTime() <= Date.now() ||
    inv.organization.deletedAt ||
    inv.organization.deletionScheduledAt
  ) {
    return null;
  }
  return {
    organizationName: inv.organization.name,
    role: inv.role,
    invitedByName: inv.invitedBy.name,
    email: inv.email,
    expiresAt: inv.expiresAt,
  };
}

/**
 * Accept: email must match; the inviter must *still* be allowed to grant the
 * role (a demoted or removed inviter's links die with their rights); the
 * single-use claim is one conditional update, so a token cannot be used twice
 * even concurrently.
 */
export async function acceptInvitation(
  userId: string,
  userEmail: string,
  token: string,
  db: Db = prisma,
) {
  const inv = await db.invitation.findUnique({ where: { tokenHash: hashInviteToken(token) } });
  const now = new Date();
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= now) {
    throw new AppError('conflict', INVALID_INVITE);
  }
  if (inv.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw AppError.forbidden(
      'This invitation was sent to a different email address. Sign in with that address to accept it.',
    );
  }
  const org = await db.organization.findUnique({
    where: { id: inv.organizationId },
    select: { deletedAt: true, deletionScheduledAt: true },
  });
  if (!org || org.deletedAt || org.deletionScheduledAt)
    throw new AppError('conflict', INVALID_INVITE);

  const inviter = await db.membership.findUnique({
    where: {
      userId_organizationId: { userId: inv.invitedById, organizationId: inv.organizationId },
    },
    select: { role: true, status: true },
  });
  if (
    !inviter ||
    inviter.status !== 'ACTIVE' ||
    !roleHasPermission(inviter.role, 'member.invite') ||
    !invitableRoles(inviter.role).includes(inv.role)
  ) {
    log.warn({ invitationId: inv.id }, 'invitation refused: inviter no longer entitled');
    throw new AppError('conflict', INVALID_INVITE);
  }

  const claimed = await db.invitation.updateMany({
    where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now, acceptedById: userId },
  });
  if (claimed.count === 0) throw new AppError('conflict', INVALID_INVITE);

  const membership = await db.membership.upsert({
    where: { userId_organizationId: { userId, organizationId: inv.organizationId } },
    // Already a member: accepting never changes an existing role.
    update: {},
    create: {
      userId,
      organizationId: inv.organizationId,
      role: inv.role,
      invitedById: inv.invitedById,
    },
  });
  await recordAudit(
    {
      organizationId: inv.organizationId,
      actorId: userId,
      action: 'member.joined',
      targetType: 'invitation',
      targetId: inv.id,
      metadata: { role: membership.role },
    },
    db,
  );
  return membership;
}
