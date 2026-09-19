import type { Metadata } from 'next';
import { prisma } from '@growth-agent/db';
import { AccountDataAndDeletion } from '@/components/app/settings/account-danger';
import { requireUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Data & deletion · Settings' };

export default async function AccountSettingsPage() {
  const user = await requireUser();
  const [row, ownerships] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { deletionScheduledAt: true } }),
    prisma.membership.findMany({
      where: {
        userId: user.id,
        role: 'OWNER',
        status: 'ACTIVE',
        organization: { deletedAt: null },
      },
      select: { organizationId: true, organization: { select: { name: true } } },
    }),
  ]);
  // Organizations where this user is the only owner are deleted with them —
  // say so before they confirm (Part 29).
  const soleOwnerOf: string[] = [];
  for (const o of ownerships) {
    const owners = await prisma.membership.count({
      where: { organizationId: o.organizationId, role: 'OWNER', status: 'ACTIVE' },
    });
    if (owners <= 1) soleOwnerOf.push(o.organization.name);
  }
  return (
    <AccountDataAndDeletion
      deletionScheduledAt={row?.deletionScheduledAt?.toISOString() ?? null}
      soleOwnerOf={soleOwnerOf}
    />
  );
}
