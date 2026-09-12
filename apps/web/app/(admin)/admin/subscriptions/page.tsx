import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { DataTable, Pager } from '@/components/admin/data-table';
import { Stat, StatGrid } from '@/components/admin/stat';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Subscriptions · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tier = typeof sp.tier === 'string' ? sp.tier : undefined;
  const status = typeof sp.status === 'string' ? sp.status : undefined;
  const page = typeof sp.page === 'string' ? Number(sp.page) || 1 : 1;

  const [overview, result] = await Promise.all([
    observability.subscriptionsOverview(prisma),
    observability.listSubscriptions(prisma, { tier, status, page }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Subscriptions"
        description="Mirror of Stripe state. Customer / subscription ids are masked."
      />

      <StatGrid>
        {overview.byTier.map((t) => (
          <Stat key={t.tier} label={t.tier} value={t.count} />
        ))}
        <Stat label="Trials ending · 7d" value={overview.trialsEndingIn7d} />
      </StatGrid>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">By status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 text-sm">
          {overview.byStatus.map((s) => (
            <span key={s.status}>
              <Badge variant="outline">{s.status}</Badge> {s.count}
            </span>
          ))}
        </CardContent>
      </Card>

      <DataTable
        rows={result.rows}
        rowKey={(r) => r.id}
        empty="No subscriptions match."
        columns={[
          {
            key: 'org',
            header: 'Organization',
            cell: (r) => (
              <Link
                href={`/admin/organizations/${r.org.id}`}
                className="font-medium hover:underline"
              >
                {r.org.name}
              </Link>
            ),
          },
          { key: 'tier', header: 'Tier', cell: (r) => <Badge variant="outline">{r.tier}</Badge> },
          { key: 'status', header: 'Status', cell: (r) => r.status },
          { key: 'interval', header: 'Interval', cell: (r) => r.interval },
          { key: 'seats', header: 'Seats', cell: (r) => r.seats },
          {
            key: 'period',
            header: 'Renews',
            cell: (r) =>
              r.currentPeriodEnd
                ? `${relDate(r.currentPeriodEnd)}${r.cancelAtPeriodEnd ? ' (cancels)' : ''}`
                : '—',
          },
          {
            key: 'stripe',
            header: 'Stripe',
            cell: (r) => <span className="font-mono text-[11px]">{r.stripeCustomer ?? '—'}</span>,
          },
        ]}
      />
      <Pager
        basePath="/admin/subscriptions"
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        searchParams={{ tier, status }}
      />
    </div>
  );
}
