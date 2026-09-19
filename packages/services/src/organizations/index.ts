import { getOrganizationForUser, listOrganizationsForUser, prisma } from '@growth-agent/db';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';
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

// Members, roles and invitations live in ./members.ts (Phase 2).
export {
  INVITE_TTL_MS,
  MAX_INVITE_SENDS,
  acceptInvitation,
  hashInviteToken,
  inviteMember,
  inviteMemberInput,
  listInvitations,
  listMembers,
  previewInvitation,
  removeMember,
  resendInvitation,
  revokeInvitation,
  transferOwnership,
  updateMemberRole,
  updateMemberRoleInput,
  type InviteResult,
} from './members.js';
export {
  getOrganizationSettings,
  isValidTimeZone,
  updateOrganizationInput,
  updateOrganizationSettings,
} from './settings.js';
