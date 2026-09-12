import type { Metadata } from 'next';
import Link from 'next/link';
import type { ErrorSource } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, PageHeader } from '@growth-agent/ui';
import { DataTable } from '@/components/admin/data-table';
import { Stat, StatGrid } from '@/components/admin/stat';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Errors · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminErrorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const source =
    sp.source === 'WEB' || sp.source === 'WORKER' ? (sp.source as ErrorSource) : undefined;

  const [rows, stats] = await Promise.all([
    observability.listErrorEvents(prisma, { limit: 200, source }),
    observability.errorStats(prisma, { sinceMs: 24 * 60 * 60 * 1000 }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Errors"
        description="De-duplicated application faults from web + worker. Messages and stacks are secret-scrubbed."
      />

      <StatGrid>
        <Stat label="Occurrences · 24h" value={stats.total} />
        <Stat label="From web · 24h" value={stats.bySource.WEB} />
        <Stat label="From worker · 24h" value={stats.bySource.WORKER} />
        <Stat label="Distinct faults · 24h" value={stats.distinctFingerprints} />
      </StatGrid>

      <div className="flex gap-2 text-sm">
        {['', 'WEB', 'WORKER'].map((s) => (
          <Link
            key={s || 'all'}
            href={s ? `/admin/errors?source=${s}` : '/admin/errors'}
            className={`rounded border px-2 py-0.5 ${(sp.source ?? '') === s ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
          >
            {s || 'all'}
          </Link>
        ))}
      </div>

      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        empty="No errors recorded."
        columns={[
          {
            key: 'source',
            header: 'Source',
            cell: (r) => <Badge variant="outline">{r.source}</Badge>,
          },
          {
            key: 'msg',
            header: 'Error',
            cell: (r) => (
              <Link href={`/admin/errors/${r.id}`} className="hover:underline">
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground">: {r.message.slice(0, 140)}</span>
              </Link>
            ),
          },
          {
            key: 'route',
            header: 'Route',
            cell: (r) => <span className="font-mono text-[11px]">{r.route ?? '—'}</span>,
          },
          { key: 'count', header: 'Count', cell: (r) => r.count },
          { key: 'last', header: 'Last seen', cell: (r) => relDate(r.lastSeenAt) },
        ]}
      />
      {rows.length >= 200 ? (
        <p className="text-muted-foreground text-xs">
          Showing the 200 most recent. Filter to narrow.
        </p>
      ) : null}
    </div>
  );
}
