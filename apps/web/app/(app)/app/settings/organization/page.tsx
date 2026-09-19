import type { Metadata } from 'next';
import type { Role } from '@growth-agent/db';
import { can, organizations, rbac } from '@growth-agent/services';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { OrgDangerZone, OrgSettingsForm } from '@/components/app/settings/org-settings';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'Organization · Settings' };

const ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];

/** A readable subset of the permission matrix (the full list lives in docs/rbac.md). */
const MATRIX: Array<{ label: string; permission: rbac.Permission }> = [
  { label: 'View dashboards, reports, SEO results', permission: 'report.view' },
  { label: 'Use the AI agent', permission: 'agent.run' },
  { label: 'Create and edit content, drafts', permission: 'content.create' },
  { label: 'Run crawls and analyses', permission: 'seo.analyze' },
  { label: 'Create automations', permission: 'automation.create' },
  { label: 'Delete automations, manage SEO', permission: 'automation.delete' },
  { label: 'Connect / disconnect integrations', permission: 'integration.manage' },
  { label: 'Approve publishing and AI actions', permission: 'content.publish' },
  { label: 'Invite and manage members', permission: 'member.invite' },
  { label: 'Configure AI governance', permission: 'agent.configure' },
  { label: 'View the audit log', permission: 'audit.view' },
  { label: 'Create API keys', permission: 'api_key.create' },
  { label: 'View billing', permission: 'billing.view' },
  { label: 'Manage billing', permission: 'billing.manage' },
  { label: 'Transfer ownership, delete organization', permission: 'organization.delete' },
];

export default async function OrganizationSettingsPage() {
  const { user, org } = await requireActiveOrg();
  const settings = await organizations.getOrganizationSettings(user.id, org.id);

  return (
    <>
      <OrgSettingsForm
        org={{
          name: settings.name,
          slug: settings.slug,
          timezone: settings.timezone,
          defaultLocale: settings.defaultLocale,
          role: org.role,
          canUpdate: can(org.role, 'organization.update'),
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Roles</CardTitle>
          <CardDescription>
            What each role can do. Every action is checked on the server against this matrix.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Permission
                </th>
                {ROLES.map((r) => (
                  <th key={r} scope="col" className="px-2 py-2 text-center font-medium">
                    {r.charAt(0) + r.slice(1).toLowerCase()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((row) => (
                <tr key={row.permission} className="border-t">
                  <td className="py-2 pr-3">{row.label}</td>
                  {ROLES.map((r) => {
                    const yes = rbac.roleHasPermission(r, row.permission);
                    return (
                      <td key={r} className="px-2 py-2 text-center">
                        <span aria-label={yes ? 'Allowed' : 'Not allowed'}>{yes ? '✓' : '—'}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <OrgDangerZone
        orgName={settings.name}
        canDelete={can(org.role, 'organization.delete')}
        canExport={can(org.role, 'organization.update')}
        deletionScheduledAt={settings.deletionScheduledAt?.toISOString() ?? null}
      />
    </>
  );
}
