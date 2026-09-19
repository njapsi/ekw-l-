import { can } from '@growth-agent/services';
import { PageHeader } from '@growth-agent/ui';
import { SettingsNav, type SettingsNavGroup } from '@/components/app/settings/settings-nav';
import { requireActiveOrg } from '@/lib/auth';

/**
 * Settings shell. Links a member lacks the permission for are hidden here,
 * but every page and action re-checks on the server — hiding is for clarity,
 * not security.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { org } = await requireActiveOrg();
  const groups: SettingsNavGroup[] = [
    {
      label: 'Account',
      items: [
        { href: '/app/settings', label: 'Profile' },
        { href: '/app/settings/security', label: 'Security' },
        { href: '/app/settings/account', label: 'Data & deletion' },
      ],
    },
    {
      label: org.name,
      items: [
        { href: '/app/settings/organization', label: 'Organization' },
        { href: '/app/settings/members', label: 'Members & roles' },
        ...(can(org.role, 'agent.configure') || can(org.role, 'agent.view')
          ? [{ href: '/app/settings/ai-governance', label: 'AI governance' }]
          : []),
        ...(can(org.role, 'api_key.view')
          ? [{ href: '/app/settings/api-keys', label: 'API keys' }]
          : []),
        ...(can(org.role, 'audit.view')
          ? [{ href: '/app/settings/audit', label: 'Audit log' }]
          : []),
      ],
    },
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your account, security, and this organization." />
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <aside className="md:w-48 md:shrink-0">
          <SettingsNav groups={groups} />
        </aside>
        <div className="min-w-0 flex-1 space-y-6">{children}</div>
      </div>
    </div>
  );
}
