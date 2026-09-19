import type { Metadata } from 'next';
import type { Role } from '@growth-agent/db';
import { can, organizations, rbac } from '@growth-agent/services';
import { MembersPanel } from '@/components/app/settings/members-panel';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'Members · Settings' };

export default async function MembersSettingsPage() {
  const { user, org } = await requireActiveOrg();
  const [members, invitations] = await Promise.all([
    organizations.listMembers(user.id, org.id),
    organizations.listInvitations(user.id, org.id),
  ]);
  const role = org.role;
  // Roles this user may hand out: never above their own; OWNER only by an OWNER.
  const assignable = rbac.ROLES_BY_RANK.filter((r) =>
    r !== 'OWNER' ? rbac.ROLE_RANK[r] <= rbac.ROLE_RANK[role] : role === 'OWNER',
  ) as Role[];

  return (
    <MembersPanel
      data={{
        selfId: user.id,
        selfRole: role,
        assignableRoles: can(role, 'member.update_role') ? assignable : [],
        invitableRoles: rbac.invitableRoles(role),
        canManageRoles: can(role, 'member.update_role'),
        canRemove: can(role, 'member.remove'),
        canTransfer: can(role, 'ownership.transfer'),
        members: members.map((m) => ({
          userId: m.user.id,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          joinedAt: m.createdAt.toISOString(),
          lastActiveAt: m.user.lastActiveAt?.toISOString() ?? null,
        })),
        invitations: invitations.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          expiresAt: i.expiresAt.toISOString(),
          expired: i.expired,
          sendCount: i.sendCount,
          invitedBy: i.invitedBy.name ?? i.invitedBy.email,
        })),
      }}
    />
  );
}
