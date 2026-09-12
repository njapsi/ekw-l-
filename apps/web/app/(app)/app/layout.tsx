import type { ReactNode } from 'react';
import { listOrganizationsForUser } from '@growth-agent/db';
import { AppShell } from '@/components/app/app-shell';
import { requireActiveOrg } from '@/lib/auth';

// The authenticated app is per-request: session, active org, and all data are
// resolved on every request.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, org } = await requireActiveOrg();
  const orgs = await listOrganizationsForUser(user.id);

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        image: user.image,
        isPlatformStaff: user.isPlatformStaff,
      }}
      organizations={orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role }))}
      activeOrgId={org.id}
    >
      {children}
    </AppShell>
  );
}
