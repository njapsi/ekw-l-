import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { DataTable } from '@/components/admin/data-table';
import { usd } from '@/lib/admin-format';
import { fullNumber, relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Organization · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminOrganizationDetail({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const org = await observability.getOrganizationDetail(prisma, orgId);
  if (!org) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={org.name}
        description={`/${org.slug} · created ${relDate(org.createdAt)}`}
      />
      <Link href="/admin/organizations" className="text-xs underline">
        ← All organizations
      </Link>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Subscription</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {org.subscription ? (
              <>
                <p>
                  <Badge variant="outline">{org.subscription.tier}</Badge>{' '}
                  <span className="text-muted-foreground">
                    {org.subscription.status} · {org.subscription.interval} ·{' '}
                    {org.subscription.seats} seat(s)
                  </span>
                </p>
                <p className="text-muted-foreground">
                  Period ends:{' '}
                  {org.subscription.currentPeriodEnd
                    ? relDate(org.subscription.currentPeriodEnd)
                    : '—'}
                  {org.subscription.cancelAtPeriodEnd ? ' · cancels at period end' : ''}
                </p>
                <p className="text-muted-foreground font-mono text-xs">
                  {org.subscription.stripeCustomer ?? 'no stripe customer'} ·{' '}
                  {org.subscription.stripeSubscription ?? 'no stripe subscription'}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">No subscription row (FREE).</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Usage · current period</CardTitle>
          </CardHeader>
          <CardContent>
            {org.usage.length === 0 ? (
              <p className="text-muted-foreground text-sm">No usage counters this period.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {org.usage.map((u) => (
                  <li key={u.meter} className="flex justify-between">
                    <span className="text-muted-foreground">{u.meter}</span>
                    <span className="tabular-nums">
                      {fullNumber(u.used)}
                      {u.limit != null ? ` / ${fullNumber(u.limit)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Members ({org.members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={org.members}
            rowKey={(m) => m.userId}
            columns={[
              { key: 'email', header: 'Email', cell: (m) => m.email },
              {
                key: 'role',
                header: 'Role',
                cell: (m) => <Badge variant="outline">{m.role}</Badge>,
              },
              { key: 'status', header: 'Status', cell: (m) => m.status },
              { key: 'joined', header: 'Joined', cell: (m) => relDate(m.joinedAt) },
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent agent runs</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={org.recentAgentRuns}
              rowKey={(r) => r.id}
              empty="No agent runs."
              columns={[
                { key: 'agent', header: 'Agent', cell: (r) => r.agent },
                { key: 'status', header: 'Status', cell: (r) => r.status },
                { key: 'cost', header: 'Cost', cell: (r) => usd(r.costUsd) },
                { key: 'when', header: 'When', cell: (r) => relDate(r.createdAt) },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent crawls</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={org.recentCrawls}
              rowKey={(c) => c.id}
              empty="No crawls."
              columns={[
                { key: 'status', header: 'Status', cell: (c) => c.status },
                { key: 'pages', header: 'Pages', cell: (c) => c.pagesCrawled },
                { key: 'issues', header: 'Issues', cell: (c) => c.issuesFound },
                { key: 'when', header: 'When', cell: (c) => relDate(c.createdAt) },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent audit events</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={org.recentAudit}
            rowKey={(a) => a.id}
            empty="No audit events."
            columns={[
              {
                key: 'action',
                header: 'Action',
                cell: (a) => <span className="font-mono">{a.action}</span>,
              },
              { key: 'actor', header: 'Actor', cell: (a) => a.actorType.toLowerCase() },
              { key: 'when', header: 'When', cell: (a) => relDate(a.createdAt) },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
