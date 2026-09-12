import { createHash, randomBytes } from 'node:crypto';
import {
  getOrganizationForUser,
  listOrganizationsForUser,
  prisma,
  requireMembership,
} from '@growth-agent/db';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';
import { createNotification } from '../notifications/index.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac/authorize.js';
import { uniqueSlug } from './slug.js';

export { slugify, uniqueSlug } from './slug.js';
export {
  GRACE_DAYS,
  requestOrganizationDeletion,
  cancelOrganizationDeletion,
  purgeOrganization,
  requestAccountDeletion,
  cancelAccountDeletion,
  purgeUser,
  runLifecycleSweepJob,
  type OrgDeletionState,
  type AccountDeletionState,
} from './lifecycle.js';
export { exportOrganizationData, serializeExport, type OrganizationExport } from './export.js';

export const createOrganizationInput = z.object({
  name: z.string().min(2).max(80),
  type: z.enum(['PERSONAL', 'TEAM', 'AGENCY', 'BUSINESS']).default('TEAM'),
});

/** Create an organization and make the caller its OWNER. */
export async function createOrganization(
  userId: string,
  raw: z.infer<typeof createOrganizationInput>,
) {
  const input = createOrganizationInput.parse(raw);
  const slug = await uniqueSlug(input.name, async (candidate) => {
    const existing = await prisma.organization.findUnique({ where: { slug: candidate } });
    return existing !== null;
  });

  const org = await prisma.organization.create({
    data: {
      name: input.name,
      slug,
      type: input.type,
      memberships: { create: { userId, role: 'OWNER' } },
    },
  });

  await recordAudit({
    organizationId: org.id,
    actorId: userId,
    action: 'organization.created',
    targetType: 'organization',
    targetId: org.id,
    metadata: { slug: org.slug },
  });

  return org;
}

export const listOrganizations = listOrganizationsForUser;
export const getOrganization = getOrganizationForUser;

/** Ensure the user has a personal organization; create one on first login. */
export async function ensurePersonalOrganization(user: {
  id: string;
  name?: string | null;
  email: string;
}) {
  const orgs = await listOrganizationsForUser(user.id);
  if (orgs.length > 0) return orgs;
  const name = user.name?.trim() || user.email.split('@')[0] || 'My workspace';
  await createOrganization(user.id, { name: `${name}'s workspace`, type: 'PERSONAL' });
  return listOrganizationsForUser(user.id);
}

// --- Members --------------------------------------------------------------

export async function listMembers(actorUserId: string, organizationId: string) {
  const membership = await requireMembership(actorUserId, organizationId);
  authorize(
    { userId: actorUserId, role: membership.role, membershipStatus: membership.status },
    'org:read',
  );
  return prisma.membership.findMany({
    where: { organizationId },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

export const updateMemberRoleInput = z.object({
  targetUserId: z.string().min(1),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
});

export async function updateMemberRole(
  actorUserId: string,
  organizationId: string,
  raw: z.infer<typeof updateMemberRoleInput>,
) {
  const input = updateMemberRoleInput.parse(raw);
  const actor = await requireMembership(actorUserId, organizationId);
  authorize(
    { userId: actorUserId, role: actor.role, membershipStatus: actor.status },
    'member:manage',
  );

  const target = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: input.targetUserId, organizationId } },
  });
  if (!target) throw AppError.notFound('Member');

  // Never leave an organization without an OWNER.
  if (target.role === 'OWNER' && input.role !== 'OWNER') {
    const owners = await prisma.membership.count({ where: { organizationId, role: 'OWNER' } });
    if (owners <= 1) {
      throw AppError.conflict('An organization must always have at least one owner.');
    }
  }

  const updated = await prisma.membership.update({
    where: { userId_organizationId: { userId: input.targetUserId, organizationId } },
    data: { role: input.role },
  });

  await recordAudit({
    organizationId,
    actorId: actorUserId,
    action: 'member.role_changed',
    targetType: 'user',
    targetId: input.targetUserId,
    metadata: { from: target.role, to: input.role },
  });

  return updated;
}

// --- Invitations -------------------------------------------------------------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const inviteMemberInput = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

export async function inviteMember(
  actorUserId: string,
  organizationId: string,
  raw: z.infer<typeof inviteMemberInput>,
) {
  const input = inviteMemberInput.parse(raw);
  const actor = await requireMembership(actorUserId, organizationId);
  authorize(
    { userId: actorUserId, role: actor.role, membershipStatus: actor.status },
    'member:manage',
  );

  const token = randomBytes(24).toString('base64url');
  const invitation = await prisma.invitation.create({
    data: {
      organizationId,
      email: input.email.toLowerCase(),
      role: input.role,
      tokenHash: hashToken(token),
      invitedById: actorUserId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  await recordAudit({
    organizationId,
    actorId: actorUserId,
    action: 'invitation.created',
    targetType: 'invitation',
    targetId: invitation.id,
    metadata: { email: input.email, role: input.role },
  });

  // Notify existing members (one row each — per-user read state).
  const members = await prisma.membership.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: { userId: true },
  });
  for (const m of members) {
    await createNotification({
      organizationId,
      userId: m.userId,
      kind: 'member.invited',
      level: 'INFO',
      title: 'Team invitation sent',
      body: `An invitation to join as ${input.role} was created for ${input.email}.`,
      linkPath: '/app/settings',
      dedupeKey: `invite:${invitation.id}:${m.userId}`,
      sourceType: 'invitation',
      sourceId: invitation.id,
      email: false, // in-app only — the invitee is emailed separately
    });
  }

  // The raw token is returned once so the caller can build the accept URL.
  return { invitation, token };
}

export async function acceptInvitation(userId: string, userEmail: string, token: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!invitation || invitation.revokedAt || invitation.acceptedAt) {
    throw AppError.notFound('Invitation');
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new AppError('conflict', 'This invitation has expired.');
  }
  if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw AppError.forbidden('This invitation was sent to a different email address.');
  }

  const membership = await prisma.$transaction(async (tx) => {
    const m = await tx.membership.upsert({
      where: { userId_organizationId: { userId, organizationId: invitation.organizationId } },
      update: {},
      create: {
        userId,
        organizationId: invitation.organizationId,
        role: invitation.role,
        invitedById: invitation.invitedById,
      },
    });
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
    return m;
  });

  await recordAudit({
    organizationId: invitation.organizationId,
    actorId: userId,
    action: 'invitation.accepted',
    targetType: 'invitation',
    targetId: invitation.id,
  });

  return membership;
}
