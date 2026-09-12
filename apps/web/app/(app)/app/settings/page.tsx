import type { Metadata } from 'next';
import { organizations, users } from '@growth-agent/services';
import { can } from '@growth-agent/services';
import { prisma } from '@growth-agent/db';
import { PageHeader } from '@growth-agent/ui';
import { SettingsTabs } from '@/components/app/settings/settings-tabs';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const { user, org } = await requireActiveOrg();
  const [profile, members, orgRow, userRow] = await Promise.all([
    users.getProfile(user.id),
    organizations.listMembers(user.id, org.id),
    prisma.organization.findUnique({
      where: { id: org.id },
      select: { deletionScheduledAt: true },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { deletionScheduledAt: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your profile, organization, and team." />
      <SettingsTabs
        data={{
          profile: {
            name: profile?.name ?? null,
            email: profile?.email ?? user.email,
            timezone: profile?.timezone ?? 'UTC',
          },
          org: { id: org.id, name: org.name, slug: org.slug, role: org.role },
          canManageMembers: can(org.role, 'member:manage'),
          canRenameOrg: can(org.role, 'org:update'),
          canDeleteOrg: can(org.role, 'org:delete'),
          canExportData: can(org.role, 'org:update'),
          orgDeletionScheduledAt: orgRow?.deletionScheduledAt?.toISOString() ?? null,
          accountDeletionScheduledAt: userRow?.deletionScheduledAt?.toISOString() ?? null,
          members: members.map((m) => ({
            userId: m.user.id,
            name: m.user.name,
            email: m.user.email,
            role: m.role,
          })),
        }}
      />
    </div>
  );
}
