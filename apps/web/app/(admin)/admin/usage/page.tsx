import type { Metadata } from 'next';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { DataTable } from '@/components/admin/data-table';
import { Stat, StatGrid } from '@/components/admin/stat';
import { fullNumber } from '@/lib/format';

export const metadata: Metadata = { title: 'Usage · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminUsagePage() {
  const overview = await observability.usageOverview(prisma);
  const rejections = observability
    .snapshot()
    .counters.filter((c) => c.name.startsWith('usage_limit_rejections_total'));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usage"
        description="Metered consumption across all tenants for the current billing period (from UsageCounter)."
      />

      <StatGrid>
        <Stat label="Orgs with usage this period" value={overview.periodedOrgs} />
        <Stat
          label="Limit rejections (this instance)"
          value={rejections.reduce((n, r) => n + r.value, 0)}
          hint="in-process counter; resets on deploy"
        />
      </StatGrid>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">By meter</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={overview.byMeter}
            rowKey={(m) => m.meter}
            empty="No usage recorded this period."
            columns={[
              {
                key: 'meter',
                header: 'Meter',
                cell: (m) => <span className="font-mono">{m.meter}</span>,
              },
              { key: 'used', header: 'Used (sum)', cell: (m) => fullNumber(m.used) },
              { key: 'orgs', header: 'Orgs', cell: (m) => m.orgs },
              {
                key: 'over',
                header: 'At / over limit',
                cell: (m) =>
                  m.atOrOverLimit > 0 ? (
                    <span className="text-destructive">{m.atOrOverLimit}</span>
                  ) : (
                    '0'
                  ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
